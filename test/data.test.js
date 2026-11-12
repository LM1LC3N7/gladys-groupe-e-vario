// -----------------------------------------------------------------------------
// Pure parts: Swiss days and clock changes, the reading of the answers, the
// records read back from /data, the inputs and the pricing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { dayRecord, parseAnswer, restoreDay, sameDay } from '../src/data.js';
import { contractInputs, currentPrice, intervalCosts, priceAt } from '../src/tariff.js';
import { addDays, dayOf, dayStart, daysBetween, quartersOf } from '../src/time.js';
import { answer, entry, pricesAt } from './fixtures/groupe-e.js';

const MINUTE = 60_000;
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('Swiss days: midnight, 92, 96 and 100 quarter hours, month ends', () => {
  assert.equal(dayStart('2026-11-11'), Date.parse('2026-11-10T23:00:00Z'));
  assert.equal(dayStart('2026-07-01'), Date.parse('2026-06-30T22:00:00Z'));
  assert.equal(quartersOf('2026-03-29'), 92);
  assert.equal(quartersOf('2026-10-25'), 100);
  assert.equal(quartersOf('2026-11-11'), 96);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayOf(Date.parse('2026-11-10T23:00:00Z')), '2026-11-11');
  assert.equal(dayOf(Date.parse('2026-11-10T22:59:59Z')), '2026-11-10');
  assert.deepEqual(daysBetween('2026-11-10', '2026-11-12'), [
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
  ]);
  assert.deepEqual(daysBetween('2026-11-12', '2026-11-10'), []);
});

test('the autumn change: 02:00-03:00 twice, each quarter its own price', () => {
  const start = dayStart('2026-10-25');
  const parsed = parseAnswer(answer(start, start + 25 * 60 * MINUTE, start + 2 * 86_400_000));
  const record = dayRecord('2026-10-25', parsed.quarters);
  assert.equal(record.known, 100);
  // 02:00 CEST is 00:00 UTC, 02:00 CET is 01:00 UTC: two instants, two slots.
  const first = Date.parse('2026-10-25T00:00:00Z');
  const second = Date.parse('2026-10-25T01:00:00Z');
  const days = new Map([['2026-10-25', record]]);
  close(priceAt(days, 'integrated', first), pricesAt(first).integrated);
  close(priceAt(days, 'integrated', second), pricesAt(second).integrated);
  assert.notEqual(priceAt(days, 'integrated', first), priceAt(days, 'integrated', second));
  assert.match(answer(first, first + 15 * MINUTE, first).prices[0].start_timestamp, /\+02:00$/);
  assert.match(answer(second, second + 15 * MINUTE, first).prices[0].start_timestamp, /\+01:00$/);
});

test('the reading of an answer: strict envelope, strict quarters, conflicts dropped', () => {
  for (const bad of [null, [], 'x', {}, { prices: {} }]) {
    assert.throws(() => parseAnswer(bad), /tariff answer|price list/);
  }
  assert.throws(() => parseAnswer({ prices: Array(1001).fill({}) }), /too many/);
  const t = dayStart('2026-11-11');
  const good = entry(t);
  const cases = [
    { ...good, start_timestamp: '2026-11-11 00:00' },
    {
      ...good,
      start_timestamp: '2026-11-11T00:07:00+01:00',
      end_timestamp: '2026-11-11T00:22:00+01:00',
    },
    { ...good, end_timestamp: good.start_timestamp },
    { ...good, grid: [] },
    {
      ...good,
      grid: [
        { unit: 'CHF_kWh', value: 0.1 },
        { unit: 'CHF_kWh', value: 0.2 },
      ],
    },
    { ...good, integrated: [{ unit: 'CHF_kWh', value: Infinity }] },
    { ...good, integrated: [{ unit: 'CHF_kWh', value: '0.2' }] },
    { ...good, integrated: [{ unit: 'Rp_kWh', value: 20 }] },
    { ...good, integrated: [{ unit: 'CHF_kWh', value: -6 }] },
    null,
    [],
  ];
  for (const c of cases) {
    const parsed = parseAnswer({ publication_timestamp: '', prices: [c] });
    assert.equal(parsed.quarters.size, 0, JSON.stringify(c));
    assert.equal(parsed.refused, 1);
  }
  const negative = parseAnswer({
    prices: [{ ...good, integrated: [{ unit: 'CHF_kWh', value: -0.05 }] }],
  });
  assert.equal(negative.quarters.get(t).integrated, -0.05, 'a negative price is a price');
  const conflict = parseAnswer({ prices: [good, entry(t, { integrated: 0.9, grid: 0.1 }), good] });
  assert.equal(conflict.quarters.size, 0, 'two prices for one quarter: neither');
  const twice = parseAnswer({ prices: [good, good] });
  assert.equal(twice.quarters.size, 1, 'the same price twice is one quarter');
  assert.equal(
    parseAnswer({ publication_timestamp: '2026-11-10T14:50:43+01:00', prices: [] }).publication,
    '2026-11-10T13:50:43.000Z',
  );
  assert.equal(
    parseAnswer({ publication_timestamp: 'yesterday', prices: [] }).publication,
    undefined,
  );
  const polluted = parseAnswer(JSON.parse('{"prices":[],"__proto__":{"x":1}}'));
  assert.equal(polluted.quarters.size, 0);
  assert.equal({}.x, undefined);
});

test('a day read back from /data: the right length, numbers or null in pairs', () => {
  const day = '2026-11-11';
  const full = Array(96).fill(0.1);
  assert.equal(restoreDay(day, { integrated: full, grid: full }).known, 96);
  const holes = [...full];
  holes[3] = null;
  assert.equal(restoreDay(day, { integrated: holes, grid: holes }).known, 95);
  assert.equal(
    restoreDay(day, { integrated: holes, grid: full }),
    undefined,
    'a half-known quarter',
  );
  assert.equal(restoreDay(day, { integrated: full.slice(1), grid: full }), undefined);
  assert.equal(restoreDay(day, { integrated: [...full.slice(1), '0.1'], grid: full }), undefined);
  assert.equal(restoreDay(day, { integrated: [...full.slice(1), 7], grid: full }), undefined);
  assert.equal(restoreDay(day, null), undefined);
  assert.equal(restoreDay(day, []), undefined);
  const a = restoreDay(day, { integrated: full, grid: full });
  assert.ok(sameDay(a, restoreDay(day, { integrated: full, grid: full })));
  assert.ok(!sameDay(a, restoreDay(day, { integrated: holes, grid: holes })));
  assert.ok(!sameDay(a, undefined));
});

test('the request windows: contiguous runs of 7 days at most, most recent first', () => {
  const days = daysBetween('2026-11-01', '2026-11-11');
  days.push('2026-09-15');
  assert.deepEqual(App.chunks(days), [
    [
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ],
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
    ['2026-09-15'],
  ]);
});

test('the publication hour on the days of a clock change is 15:00 Swiss time', () => {
  const app = new App({ gladys: {}, store: {} });
  // Before 15:00 the last day expected is today, from 15:00 tomorrow.
  for (const day of ['2026-03-29', '2026-10-25', '2026-11-11']) {
    const start = dayStart(day);
    const at15 = start + (day === '2026-03-29' ? 14 : day === '2026-10-25' ? 16 : 15) * 60 * MINUTE;
    assert.equal(app.lastExpected(at15 - 1), day, day);
    assert.equal(app.lastExpected(at15), addDays(day, 1), day);
  }
});

test('the inputs: empty takes the default, numbers in bounds only', () => {
  const contract = (inputs, key = 'groupe-e-vario-grid') => ({ template_key: key, inputs });
  assert.deepEqual(contractInputs(contract({})), {
    kind: 'grid',
    energy: 0,
    supplement: 0,
    vat: 0,
  });
  assert.deepEqual(contractInputs(contract({ energy_chf_kwh: '0.12', vat_percent: ' ' })), {
    kind: 'grid',
    energy: 0.12,
    supplement: 0,
    vat: 0,
  });
  assert.equal(
    contractInputs(contract({ energy_chf_kwh: 1 }, 'groupe-e-vario')).energy,
    0,
    'not an input of the integrated template',
  );
  for (const bad of [
    { vat_percent: 101 },
    { energy_chf_kwh: -0.1 },
    { supplement_chf_kwh: 'abc' },
    { supplement_chf_kwh: '1e3' },
    { fixed_chf_month: 2000 },
    { vat_percent: NaN },
    { vat_percent: true },
  ]) {
    assert.throws(() => contractInputs(contract(bad)), /must be a number/, JSON.stringify(bad));
  }
  assert.throws(() => contractInputs({ template_key: 'x' }), /Unknown contract template/);
  assert.throws(() => contractInputs(undefined), /Unknown contract template/);
  assert.deepEqual(contractInputs({ template_key: 'groupe-e-vario', inputs: [] }).vat, 0);
});

test('the pricing request is checked: start, energy, size', () => {
  const day = '2026-11-11';
  const days = new Map([
    [day, restoreDay(day, { integrated: Array(96).fill(0.2), grid: Array(96).fill(0.1) })],
  ]);
  const contract = { template_key: 'groupe-e-vario', inputs: {} };
  const t = new Date(dayStart(day)).toISOString();
  close(intervalCosts(days, contract, [{ starts_at: t, kwh: 1.5 }])[0].cost, 0.3);
  for (const bad of [
    [{ starts_at: 'x', kwh: 1 }],
    [{ starts_at: new Date(dayStart(day) + 60_000).toISOString(), kwh: 1 }],
    [{ starts_at: t, kwh: -1 }],
    [{ starts_at: t, kwh: '1' }],
    [{ starts_at: t, kwh: NaN }],
    [{ starts_at: dayStart(day), kwh: 1 }],
  ]) {
    assert.throws(
      () => intervalCosts(days, contract, bad),
      /Invalid interval/,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => intervalCosts(days, contract, Array(2001).fill({ starts_at: t, kwh: 1 })),
    /Invalid pricing request/,
  );
  // The last half hour of the day needs the first quarter of the next one? No: 23:30 and 23:45.
  const last = new Date(dayStart(day) + 95 * 15 * MINUTE - 15 * MINUTE).toISOString();
  close(intervalCosts(days, contract, [{ starts_at: last, kwh: 1 }])[0].cost, 0.2);
  // 23:45 + 00:00 of the next day, not held: the whole request fails with the day named.
  const across = new Date(dayStart(day) + 95 * 15 * MINUTE).toISOString();
  assert.throws(
    () => intervalCosts(days, contract, [{ starts_at: across, kwh: 1 }]),
    (err) => err.days?.join() === '2026-11-12',
  );
  assert.deepEqual(currentPrice(days, contract, dayStart(day) + 95 * 15 * MINUTE + 1), {
    price: 0.2,
    valid_until: new Date(dayStart(day) + 96 * 15 * MINUTE).toISOString(),
    next_price: null,
    label: 'Vario',
  });
  assert.deepEqual(currentPrice(days, contract, dayStart(day) - 1), { price: null });
});
