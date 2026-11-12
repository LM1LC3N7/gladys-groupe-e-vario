// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 20,000 times and a real
// local HTTP server: the next day is asked once a day at 15:00, never sooner,
// and nothing leaves after stop. Wide margins: a timer is late under load,
// never early.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { API_URL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { answer } from './fixtures/groupe-e.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

const DAY = 24 * 60 * 60_000;

test('real clock: the next day asked once a day, nothing after stop', async (t) => {
  const clock = realClock({ speed: 20_000 });
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const from = Date.parse(u.searchParams.get('start_timestamp'));
    const to = Date.parse(u.searchParams.get('end_timestamp'));
    requests.push({ from, to, ua: req.headers['user-agent'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer(from, to, clock.now())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gladys = createFakeGladys({
    selector: 'groupe-e-vario',
    energyCalendars: { 'groupe-e-vario': [], 'groupe-e-vario-grid': [] },
  });
  await gladys.connect();
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (url, init) =>
      fetch(String(url).replace(API_URL, `${base}/v2/tariffs`), {
        ...init,
        signal: AbortSignal.timeout(5000),
      }),
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const spy = spyOn(app, 'runCheck', clock);
  await app.start();
  // The first check (backfill), then one a day at 15:00.
  const deadline = performance.now() + 30_000;
  while (spy.calls.length < 4 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const daily = { clock, calls: spy.calls.slice(1) };
  const gaps = await measurePeriod(daily, { count: 3, period: DAY, timeoutMs: 1000 });
  assert.equal(gaps.length, 2);
  // The last check may still be in flight: its request lands before the counts.
  await app.idle();
  for (const r of requests.slice(-3)) {
    assert.equal(r.to - r.from, DAY, 'the daily checks ask one day only');
  }
  assert.match(requests[0].ua, /^gladys-groupe-e-vario\//);
  await app.stop();
  const count = requests.length;
  const timers = clock.timersSet;
  await clock.sleep(2 * DAY);
  assert.equal(requests.length, count, 'no request after stop');
  assert.equal(clock.timersSet, timers, 'no timer after stop');
});
