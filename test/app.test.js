// -----------------------------------------------------------------------------
// The app: requests, schedule, /data, status, calendars, delegated pricing
// through the fake Gladys. Virtual clock, scripted API.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { USER_AGENT } from '../src/constants.js';
import { addDays, dayOf, dayStart } from '../src/time.js';
import { parseAnswer } from '../src/data.js';
import { answer, entry, pricesAt } from './fixtures/groupe-e.js';
import {
  CONTRACT,
  DAY,
  GRID_CONTRACT,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  json,
  priceRequest,
  setup,
} from './helpers/app.js';

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const status = (gladys) => gladys.fake.connectionStatus;
const iso = (t) => new Date(t).toISOString();
/** The local day of a request window. */
const daysOf = (r) => [dayOf(r.from), dayOf(r.to - 1)];
/** 15:00 Swiss time on 11 November 2026 is 14:00 UTC; NOW is 10:00. */
const TO_15H = 5 * HOUR;

test('first start: the last 35 days asked in 7-day windows, kept, fed to both calendars', async () => {
  const { gladys, source, store, app } = await setup();
  assert.deepEqual(source.requests.map(daysOf), [
    ['2026-11-05', '2026-11-11'],
    ['2026-10-29', '2026-11-04'],
    ['2026-10-22', '2026-10-28'],
    ['2026-10-15', '2026-10-21'],
    ['2026-10-08', '2026-10-14'],
  ]);
  for (const r of source.requests) {
    assert.equal(r.headers['User-Agent'], USER_AGENT);
    assert.equal(r.headers.Accept, 'application/json');
    assert.equal(r.init.redirect, 'error');
    assert.ok(r.init.signal, 'a timeout');
    assert.match(r.url, /^https:\/\/api\.tariffs\.groupe-e\.ch\/v2\/tariffs\?start_timestamp=/);
  }
  assert.match(USER_AGENT, /^gladys-groupe-e-vario\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\//);
  assert.equal(Object.keys(store.data.days).length, 35);
  assert.equal(store.data.days['2026-10-25'].integrated.length, 100, 'autumn change: 100 quarters');
  assert.ok(store.data.checkedAt >= NOW);
  const integrated = gladys.fake.energyCalendars['groupe-e-vario'];
  const grid = gladys.fake.energyCalendars['groupe-e-vario-grid'];
  assert.equal(integrated.length, 34 * 96 + 100);
  assert.equal(grid.length, 34 * 96 + 100);
  const first = Date.parse(
    integrated.find((e) => e.starts_at.startsWith('2026-11-11T00:00')).starts_at,
  );
  close(
    integrated.find((e) => e.starts_at.startsWith('2026-11-11T00:00')).value,
    pricesAt(first).integrated,
  );
  close(grid.find((e) => e.starts_at.startsWith('2026-11-11T00:00')).value, pricesAt(first).grid);
  const s = status(gladys);
  assert.equal(s.connected, true);
  assert.match(s.message.en, /known through 2026-11-11/);
  assert.match(s.message.fr, /connus jusqu’au 2026-11-11/);
  assert.match(s.message.en, /Source: Groupe E\./);
  assert.equal(gladys.fake.connectionStatuses[0].connected, false, 'starting first');
  assert.ok(app.timer, 'scheduled');
});

test('the next day is asked from 15:00 only, then not again', async () => {
  const { source, wait, app } = await setup();
  const before = source.count();
  await wait(TO_15H - MINUTE);
  assert.equal(source.count(), before, 'nothing before 15:00');
  await wait(MINUTE);
  assert.equal(source.count(), before + 1);
  assert.deepEqual(daysOf(source.requests.at(-1)), ['2026-11-12', '2026-11-12']);
  assert.ok(app.complete('2026-11-12'));
  await wait(DAY - MINUTE);
  assert.equal(source.count(), before + 1, 'nothing until the next 15:00');
  await wait(2 * MINUTE);
  assert.equal(source.count(), before + 2);
  assert.deepEqual(daysOf(source.requests.at(-1)), ['2026-11-13', '2026-11-13']);
});

test('a late publication: asked again every 30 minutes, never sooner, the status says so', async () => {
  let late = true;
  const { source, wait, gladys, clock } = await setup({
    handler: (r) => (late ? answer(r.from, r.to, NOW) : answer(r.from, r.to, clock.now())),
  });
  late = true;
  const before = source.count();
  await wait(TO_15H);
  assert.equal(source.count(), before + 1);
  assert.match(status(gladys).message.en, /Tomorrow is not published yet/);
  await wait(29 * MINUTE);
  assert.equal(source.count(), before + 1, 'not before 30 minutes');
  await wait(MINUTE + SECOND);
  assert.equal(source.count(), before + 2);
  late = false;
  await wait(30 * MINUTE);
  assert.equal(source.count(), before + 3);
  assert.doesNotMatch(status(gladys).message.en, /Tomorrow is not published/);
  assert.match(status(gladys).message.en, /known through 2026-11-12/);
  await wait(3 * HOUR);
  assert.equal(source.count(), before + 3);
});

test('a restart: nothing asked again, a wait in progress kept from /data', async () => {
  const store = createMemoryStore();
  const first = await setup({
    store,
    handler: (r) => (r.to - r.from <= DAY ? { publication_timestamp: '', prices: [] } : undefined),
  });
  await first.wait(TO_15H);
  const asked = first.source.count();
  assert.equal(first.app.incomplete.has('2026-11-12'), true);
  await first.app.stop();
  // Restarted 5 minutes later: the 30-minute wait holds.
  const again = await setup({ store, now: NOW + TO_15H + 5 * MINUTE });
  assert.equal(again.source.count(), 0, 'the days held are not asked again');
  await again.wait(24 * MINUTE);
  assert.equal(again.source.count(), 0);
  await again.wait(2 * MINUTE);
  assert.equal(again.source.count(), 1);
  assert.deepEqual(daysOf(again.source.requests[0]), ['2026-11-12', '2026-11-12']);
  assert.ok(asked >= 6);
  await again.app.stop();
});

test('failures: 5xx retried 5 then 15 minutes later; 429 pauses for its Retry-After, kept in /data', async () => {
  let mode = 'ok';
  const { source, wait, gladys, store } = await setup({
    handler: () => {
      if (mode === '500') return new Response('down', { status: 503 });
      if (mode === '429') return json({}, 429, { 'retry-after': '1200' });
      return undefined;
    },
  });
  mode = '500';
  const before = source.count();
  await wait(TO_15H);
  assert.equal(source.count(), before + 1);
  assert.match(status(gladys).message.en, /Last attempt failed: the API is unavailable \(5xx\)/);
  await wait(5 * MINUTE - SECOND);
  assert.equal(source.count(), before + 1);
  await wait(2 * SECOND);
  assert.equal(source.count(), before + 2);
  await wait(15 * MINUTE);
  assert.equal(source.count(), before + 3);
  mode = '429';
  await wait(30 * MINUTE);
  assert.equal(source.count(), before + 4);
  assert.ok(store.data.pausedUntil > NOW + TO_15H);
  await wait(19 * MINUTE);
  assert.equal(source.count(), before + 4, 'the pause holds');
  mode = 'ok';
  await wait(2 * MINUTE);
  assert.equal(source.count(), before + 4, 'and the back-off too (fourth failure: an hour)');
  await wait(40 * MINUTE);
  assert.equal(source.count(), before + 5);
  assert.doesNotMatch(status(gladys).message.en, /Last attempt failed/);
});

test('a 429 longer than the back-off: no request before its end', async () => {
  let limited = false;
  const { source, wait, gladys } = await setup({
    handler: () => (limited ? json({}, 429, { 'retry-after': '7200' }) : undefined),
  });
  limited = true;
  const before = source.count();
  await wait(TO_15H);
  assert.equal(source.count(), before + 1);
  assert.match(status(gladys).message.en, /asked to slow down \(429\)/);
  limited = false;
  await wait(2 * HOUR - MINUTE);
  assert.equal(source.count(), before + 1, 'the 2-hour pause holds');
  await wait(2 * MINUTE);
  assert.equal(source.count(), before + 2);
});

test('a 429 with a huge Retry-After: paused 6 hours at most, the status gives its end', async () => {
  let limited = false;
  const { source, wait, gladys, app, store } = await setup({
    handler: () => (limited ? json({}, 429, { 'retry-after': '99999999' }) : undefined),
  });
  limited = true;
  const before = source.count();
  await wait(TO_15H);
  assert.equal(source.count(), before + 1);
  assert.equal(
    Math.round(store.data.pausedUntil - store.data.attemptAt),
    6 * HOUR,
    'capped at 6 hours',
  );
  // 15:00 + 6 h = 21:00 Swiss time: the status says so, not the one-hour wake-up.
  assert.match(status(gladys).message.en, /next one about 2026-11-11 21:00/);
  limited = false;
  await wait(6 * HOUR - MINUTE);
  assert.equal(source.count(), before + 1, 'nothing during the pause');
  await wait(2 * MINUTE);
  assert.equal(source.count(), before + 2);
  assert.equal(app.lastError, undefined);
});

test('the status gives the real next attempt after a 404 (6 hours later)', async () => {
  let gone = false;
  const { wait, gladys } = await setup({
    handler: () => (gone ? new Response('nope', { status: 404 }) : undefined),
  });
  gone = true;
  await wait(TO_15H);
  assert.match(status(gladys).message.en, /next one about 2026-11-11 21:00/);
  assert.match(status(gladys).message.fr, /prochaine vers 2026-11-11 21:00/);
});

test('a past day answered empty is asked again once a day, not every 30 minutes', async () => {
  const { source, wait, app } = await setup({ start: false });
  source.first = '2026-10-20';
  await app.start();
  await wait(0);
  const firstDay = Date.parse('2026-10-20T00:00:00+02:00');
  const old = () => source.requests.filter((r) => r.from < firstDay).length;
  const initial = old();
  assert.ok(initial >= 2, 'the days before the history asked once');
  assert.ok(app.incomplete.has('2026-10-08'));
  await wait(DAY - 10 * MINUTE);
  assert.equal(old(), initial, 'not again within a day');
  await wait(20 * MINUTE);
  assert.ok(old() > initial, 'asked again after a day');
});

test('the days a pricing request lacks are capped at 62, asked in 9 windows at most', async () => {
  const { app, source, wait } = await setup();
  const days = [];
  for (let k = 0; k < 93; k += 1) days.push(addDays('2026-08-31', -k));
  app.want(days);
  assert.equal(app.wanted.size, 62);
  assert.equal([...app.wanted].sort()[0], addDays('2026-08-31', -61), 'the most recent kept');
  const before = source.count();
  await wait(2 * MINUTE);
  const asked = source.requests.slice(before);
  assert.ok(asked.length > 0 && asked.length <= 9, `${asked.length} requests`);
  assert.equal(app.wanted.size, 0);
});

test('a retired API (410): said in the status, asked again every 6 hours only', async () => {
  let gone = false;
  const { source, wait, gladys } = await setup({
    handler: () => (gone ? new Response('Gone', { status: 410 }) : undefined),
  });
  gone = true;
  const before = source.count();
  await wait(TO_15H);
  assert.equal(source.count(), before + 1);
  assert.match(status(gladys).message.en, /Groupe E may have retired it, update the integration/);
  assert.match(status(gladys).message.fr, /mettez l’intégration à jour/);
  await wait(6 * HOUR - MINUTE);
  assert.equal(source.count(), before + 1);
  await wait(2 * MINUTE);
  assert.equal(source.count(), before + 2);
  assert.equal(status(gladys).connected, true, 'today still priced from what is held');
});

test('an unreadable answer: refused, nothing taken, retried later; a failure stops the other windows', async () => {
  const { source, store, gladys } = await setup({
    handler: () => json({ unexpected: true }),
  });
  assert.equal(source.count(), 1, 'the other windows wait');
  assert.equal(Object.keys(store.data.days).length, 0);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /unreadable answer/);
});

test('quarters not readable stay unknown: never a zero, the pricing of them fails', async () => {
  const today = dayStart('2026-11-11');
  const bad = new Map([
    [today, (e) => (e.integrated[0].unit = 'Rp_kWh')],
    [today + 15 * MINUTE, (e) => (e.grid[0].value = '0.08')],
    [today + 30 * MINUTE, (e) => (e.integrated[0].value = null)],
    [today + 45 * MINUTE, (e) => (e.integrated[0].value = 99)],
    [today + 60 * MINUTE, (e) => delete e.end_timestamp],
  ]);
  const { gladys, app } = await setup({
    handler: (r) => {
      const out = answer(r.from, r.to, NOW);
      for (const e of out.prices) bad.get(Date.parse(e.start_timestamp))?.(e);
      // A second, different price for 01:30: neither is believed.
      if (r.from <= today && r.to > today)
        out.prices.push(entry(today + 90 * MINUTE, { integrated: 1, grid: 1 }));
      return out;
    },
  });
  const record = app.days.get('2026-11-11');
  assert.deepEqual(record.integrated.slice(0, 7), [
    null,
    null,
    null,
    null,
    null,
    record.integrated[5],
    null,
  ]);
  assert.equal(app.complete('2026-11-11'), false);
  const ack = await gladys.fake.energyPrice(priceRequest([[iso(today), 1]]));
  assert.equal(ack.success, false, 'no cost, the core retries');
  const ok = await gladys.fake.energyPrice(priceRequest([[iso(today + 2 * HOUR), 1]]));
  assert.equal(ok.success, true);
  assert.equal(
    gladys.fake.energyCalendars['groupe-e-vario'].some((e) => e.starts_at === iso(today)),
    false,
    'an unknown quarter is not published to the calendar',
  );
  assert.match(status(gladys).message.en, /Today is not complete/);
});

test('an answer never erases a price held; a changed price replaces it and is republished', async () => {
  const { app, gladys, wait } = await setup();
  const day = '2026-11-11';
  const start = dayStart(day);
  const t = start + 10 * HOUR;
  const held = app.days.get(day).integrated[40];
  const out = answer(start, start + DAY, NOW);
  out.prices = out.prices.filter((e) => Date.parse(e.start_timestamp) !== t);
  out.prices.find((e) => Date.parse(e.start_timestamp) === t + 15 * MINUTE).integrated[0].value =
    0.5;
  assert.equal(app.take([day], parseAnswer(out)), true);
  const record = app.days.get(day);
  assert.equal(record.integrated[40], held, 'absent from the answer: kept');
  assert.equal(record.integrated[41], 0.5, 'changed: replaced');
  assert.ok(app.complete(day));
  await app.publishCalendars(app.generation);
  await wait(0);
  const published = gladys.fake.energyCalendars['groupe-e-vario'].find(
    (e) => e.starts_at === iso(t + 15 * MINUTE),
  );
  assert.equal(published.value, 0.5, 'the calendar has the new price');
  // Quarters of another day are not taken.
  const other = answer(start + DAY, start + 2 * DAY, NOW + DAY);
  assert.equal(app.take([day], parseAnswer(other)), false);
});

test('delegated pricing: two quarters per half hour, grid template, supplement and VAT', async () => {
  const { gladys } = await setup({ contracts: [CONTRACT, GRID_CONTRACT] });
  const t = dayStart('2026-11-11') + 8 * HOUR;
  const p0 = pricesAt(t);
  const p1 = pricesAt(t + 15 * MINUTE);
  const ack = await gladys.fake.energyPrice(priceRequest([[iso(t), 2]]));
  assert.equal(ack.success, true, JSON.stringify(ack));
  close(ack.data.costs[0].cost, p0.integrated + p1.integrated);
  assert.equal(ack.data.costs[0].label, 'Vario');
  const grid = await gladys.fake.energyPrice(priceRequest([[iso(t), 2]], GRID_CONTRACT));
  close(grid.data.costs[0].cost, p0.grid + p1.grid + 2 * 0.1);
  assert.equal(grid.data.costs[0].label, 'Vario grid');
  const taxed = await gladys.fake.energyPrice(
    priceRequest([[iso(t), 2]], {
      ...CONTRACT,
      inputs: { supplement_chf_kwh: 0.05, vat_percent: 8.1, fixed_chf_month: 10 },
    }),
  );
  close(taxed.data.costs[0].cost, (p0.integrated + p1.integrated + 0.1) * 1.081);
  const empty = await gladys.fake.energyPrice(priceRequest([]));
  assert.equal(empty.success, true);
  const invalid = await gladys.fake.energyPrice(
    priceRequest([[iso(t), 1]], { ...CONTRACT, id: 'c9', inputs: { vat_percent: 300 } }),
  );
  assert.equal(invalid.success, false);
  assert.match(status(gladys).message.en, /1 contract\(s\) with an input out of bounds/);
  const unknownTemplate = await gladys.fake.energyPrice(
    priceRequest([[iso(t), 1]], { ...CONTRACT, template_key: 'other' }),
  );
  assert.equal(unknownTemplate.success, false);
});

test('a negative total is counted 0 and labelled (the core refuses a negative cost)', async () => {
  const t = dayStart('2026-11-11') + 13 * HOUR;
  const { gladys } = await setup({
    handler: (r) => {
      const out = answer(r.from, r.to, NOW);
      for (const e of out.prices) {
        const s = Date.parse(e.start_timestamp);
        if (s === t || s === t + 15 * MINUTE) e.integrated[0].value = -0.1;
      }
      return out;
    },
  });
  const ack = await gladys.fake.energyPrice(priceRequest([[iso(t), 1]]));
  assert.equal(ack.success, true);
  assert.equal(ack.data.costs[0].cost, 0);
  assert.match(ack.data.costs[0].label, /negative price, counted 0/);
});

test('a day the pricing lacks is asked in the background, then priced; the request itself fails', async () => {
  const { gladys, source, wait } = await setup();
  const old = dayStart('2026-09-15') + 6 * HOUR;
  const before = source.count();
  const ack = await gladys.fake.energyPrice(priceRequest([[iso(old), 1]]));
  assert.equal(ack.success, false, 'no network on the pricing path');
  await wait(0);
  assert.equal(source.count(), before, 'not before the minimum gap');
  await wait(MINUTE + SECOND);
  assert.equal(source.count(), before + 1);
  assert.deepEqual(daysOf(source.requests.at(-1)), ['2026-09-15', '2026-09-15']);
  const again = await gladys.fake.energyPrice(priceRequest([[iso(old), 1]]));
  assert.equal(again.success, true);
  close(
    again.data.costs[0].cost,
    (pricesAt(old).integrated + pricesAt(old + 15 * MINUTE).integrated) / 2,
  );
  // A day the API answers empty (before its history): asked once a day, not at every request.
  source.first = '2026-01-01';
  const ancient = dayStart('2025-12-20') + 6 * HOUR;
  await gladys.fake.energyPrice(priceRequest([[iso(ancient), 1]]));
  await wait(2 * MINUTE);
  const count = source.count();
  for (let i = 0; i < 5; i += 1) {
    await gladys.fake.energyPrice(priceRequest([[iso(ancient), 1]]));
    await wait(5 * MINUTE);
  }
  assert.equal(source.count(), count, 'an empty day waits a day');
});

test('the current price for the dashboard and the scenes', async () => {
  const { gladys } = await setup();
  const ask = (contract) =>
    gladys.fake.energyCurrent({ contract, billing_period: {}, cumulative: {}, max_power_kw: 0 });
  const ack = await ask(CONTRACT);
  assert.equal(ack.success, true);
  const t = Math.floor(NOW / (15 * MINUTE)) * 15 * MINUTE;
  close(ack.data.price, pricesAt(t).integrated);
  assert.equal(ack.data.valid_until, iso(t + 15 * MINUTE));
  close(ack.data.next_price, pricesAt(t + 15 * MINUTE).integrated);
  assert.equal(ack.data.label, 'Vario');
  const late = await setup({
    now: dayStart('2026-11-11') + 23 * HOUR + 50 * MINUTE,
    handler: (r) => answer(r.from, r.to, NOW),
  });
  const end = await late.gladys.fake.energyCurrent({
    contract: CONTRACT,
    billing_period: {},
    cumulative: {},
    max_power_kw: 0,
  });
  assert.equal(end.data.next_price, null, 'tomorrow not held: no next price, never a guess');
  const bad = await ask({ ...CONTRACT, inputs: { vat_percent: -1 } });
  assert.equal(bad.data.price, null);
});

test('/data unreadable: nothing asked, read again every 10 s; a failed write is said', async () => {
  const store = createMemoryStore();
  store.unreadable = true;
  const { source, wait, gladys } = await setup({ store });
  assert.equal(source.count(), 0);
  assert.match(status(gladys).message.en, /cannot be read/);
  await wait(30 * SECOND);
  assert.equal(source.count(), 0);
  store.unreadable = false;
  store.failSave = true;
  await wait(10 * SECOND);
  assert.equal(source.count(), 5);
  assert.match(status(gladys).message.en, /\/data cannot be written/);
});

test('/data read back strictly: a broken day, a future attempt, a pause too long are dropped', async () => {
  const store = createMemoryStore({
    attemptAt: NOW + DAY,
    pausedUntil: NOW + 30 * DAY,
    failures: -3,
    lastError: '<script>',
    days: {
      '2026-11-11': { integrated: [1, 2], grid: [1, 2] },
      '2026-11-10': { integrated: Array(96).fill('x'), grid: Array(96).fill(0.1) },
      __proto__: { polluted: true },
    },
  });
  const { app, source } = await setup({ store });
  assert.equal(app.meta.pausedUntil, undefined);
  assert.equal(app.meta.failures, 0);
  assert.equal(app.lastError, undefined);
  assert.equal(source.count(), 5, 'asked again at once: the attempt date was in the future');
  assert.equal({}.polluted, undefined);
});

test('a calendar owned by another integration: refused, said, the pricing goes on', async () => {
  const { gladys } = await setup({ calendars: { 'groupe-e-vario': [] } });
  assert.match(status(gladys).message.en, /The grid calendar is fed by another integration/);
  assert.equal(gladys.fake.energyCalendars['groupe-e-vario'].length > 0, true);
  const ack = await gladys.fake.energyPrice(priceRequest([[iso(NOW - HOUR), 1]]));
  assert.equal(ack.success, true);
});

test('a calendar that failed is fed again at the next reconnection, without asking the API', async () => {
  const { app, gladys, source, wait } = await setup();
  const original = gladys.publishEnergyCalendar.bind(gladys);
  let calls = 0;
  gladys.publishEnergyCalendar = async (...args) => {
    calls += 1;
    return original(...args);
  };
  await app.stop();
  await app.start();
  await wait(0);
  assert.equal(calls, 0, 'nothing republished: every day was received');
  await app.stop();
  app.sent.grid = {};
  const before = source.count();
  await app.start();
  await wait(0);
  assert.ok(calls >= 2, 'the grid days republished');
  assert.equal(source.count(), before);
});

test('contracts not read: secondary, the rest goes on', async () => {
  const { gladys, source, app, wait } = await setup({ start: false });
  gladys.getEnergyContracts = async () => {
    throw new Error('boom');
  };
  await app.start();
  await wait(0);
  assert.equal(source.count(), 5);
  assert.equal(status(gladys).connected, true);
});

test('stop: no request and no timer afterwards', async () => {
  const { app, clock, source, wait } = await setup();
  await app.stop();
  assert.equal(clock.pending, 0, 'the timers cleared at once');
  const count = source.count();
  await wait(3 * DAY);
  assert.equal(source.count(), count);
  assert.equal(clock.pending, 0);
});

test('spring change: a 92-quarter day priced and published', async () => {
  const { app, gladys, source } = await setup({ now: Date.parse('2026-03-29T20:00:00Z') });
  assert.equal(source.count() > 0, true);
  assert.equal(app.days.get('2026-03-29').integrated.length, 92);
  assert.ok(app.complete('2026-03-29'));
  // 01:30 to 03:00 local is 00:30 to 01:00 UTC: one half hour across the jump.
  const ack = await gladys.fake.energyPrice(priceRequest([['2026-03-29T00:30:00Z', 1]]));
  assert.equal(ack.success, true);
  const t = Date.parse('2026-03-29T00:30:00Z');
  close(
    ack.data.costs[0].cost,
    (pricesAt(t).integrated + pricesAt(t + 15 * MINUTE).integrated) / 2,
  );
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
});
