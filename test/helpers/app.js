// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Groupe E API and a virtual
// clock (each read moves it 1 µs).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../../src/app.js';
import { API_URL } from '../../src/constants.js';
import { createMemoryStore } from '../../src/store.js';
import { answer } from '../fixtures/groupe-e.js';
import { testClock } from './clock.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Wednesday 11 November 2026, 10:00 CET: today published, tomorrow not yet. */
export const NOW = Date.parse('2026-11-11T09:00:00Z');

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The API: `source.handler(request)` may return a Response, a body, 'timeout'
 * or undefined (the fictional answer at the clock's time).
 */
export function createSource(clock) {
  const source = {
    requests: [],
    handler: undefined,
    first: '2026-01-01',
    count: () => source.requests.length,
  };
  source.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const request = {
      url: String(url),
      from: Date.parse(u.searchParams.get('start_timestamp')),
      to: Date.parse(u.searchParams.get('end_timestamp')),
      headers: init.headers ?? {},
      init,
    };
    source.requests.push(request);
    if (`${u.origin}${u.pathname}` !== API_URL) return new Response('nope', { status: 404 });
    let out = source.handler ? await source.handler(request) : undefined;
    if (out === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (out instanceof Response) return out;
    if (out === undefined)
      out = answer(request.from, request.to, clock.now(), { first: source.first });
    return json(out);
  };
  return source;
}

export const CONTRACT = {
  id: 'c1',
  template_key: 'groupe-e-vario',
  inputs: { supplement_chf_kwh: 0, vat_percent: 0, fixed_chf_month: 0 },
  currency: 'CHF',
  timezone: 'Europe/Zurich',
  billing_period_start_day: 1,
};
export const GRID_CONTRACT = {
  ...CONTRACT,
  id: 'c2',
  template_key: 'groupe-e-vario-grid',
  inputs: { energy_chf_kwh: 0.1, supplement_chf_kwh: 0, vat_percent: 0, fixed_chf_month: 0 },
};

export async function setup({
  store = createMemoryStore(),
  now = NOW,
  contracts = [CONTRACT],
  start = true,
  calendars = { 'groupe-e-vario': [], 'groupe-e-vario-grid': [] },
  handler,
} = {}) {
  const gladys = createFakeGladys({
    selector: 'groupe-e-vario',
    energyContracts: contracts,
    energyCalendars: calendars,
  });
  await gladys.connect();
  const clock = testClock({ start: now });
  const source = createSource(clock);
  source.handler = handler;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new App({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: clock.now,
    timers: clock.timers,
    store,
    fetchImpl: source.fetch,
  });
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));
  const wait = async (ms) => {
    await clock.advance(ms);
    await app.idle();
  };
  if (start) {
    await app.start();
    await wait(0);
  }
  return { app, gladys, clock, store, source, wait, lines };
}

/** The pricing request of the core for `intervals` (`[[starts_at, kwh]]`). */
export const priceRequest = (intervals, contract = CONTRACT) => ({
  contract,
  billing_period: { starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' },
  cumulative_before: { day: 0, month: 0, billing_period: 0 },
  intervals: intervals.map(([starts_at, kwh]) => ({ starts_at, kwh, max_power_kw: 1 })),
});
