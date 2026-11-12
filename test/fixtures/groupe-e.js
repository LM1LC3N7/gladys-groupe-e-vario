// -----------------------------------------------------------------------------
// A fictional Groupe E tariff API: the same answer shape as the real v2 (read
// on 2026-11-11), with made-up prices. Day D is published at 15:00 Swiss time
// on D-1, as Groupe E does.
// -----------------------------------------------------------------------------

import { addDays, dayOf, dayStart, QUARTER_HOUR, zurich } from '../../src/time.js';

/** The made-up prices of the quarter starting at `t` (CHF/kWh). */
export function pricesAt(t) {
  const k = Math.round(t / QUARTER_HOUR) % 8;
  return { integrated: 0.2 + k / 100, grid: 0.08 + k / 200 };
}

/** `2026-11-11T00:15:00+01:00`: the offset of Swiss time, as the API writes it. */
export function swiss(t) {
  const p = zurich(t);
  const two = (n) => String(n).padStart(2, '0');
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = (local - t) / 3_600_000;
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:00+${two(offset)}:00`;
}

export const entry = (t, prices = pricesAt(t)) => ({
  start_timestamp: swiss(t),
  end_timestamp: swiss(t + QUARTER_HOUR),
  grid: [{ unit: 'CHF_kWh', value: prices.grid }],
  integrated: [{ unit: 'CHF_kWh', value: prices.integrated }],
});

/** The last day published at `now`. */
export function publishedThrough(now) {
  const today = dayOf(now);
  return zurich(now).hour >= 15 ? addDays(today, 1) : today;
}

/** The answer for [from, to) as the API gives it at `now` (days from `first` on only). */
export function answer(from, to, now, { first = '2026-01-01' } = {}) {
  const last = publishedThrough(now);
  const prices = [];
  for (let t = Math.ceil(from / QUARTER_HOUR) * QUARTER_HOUR; t < to; t += QUARTER_HOUR) {
    const day = dayOf(t);
    if (day >= first && day <= last) prices.push(entry(t));
  }
  const lastDay = prices.length ? dayOf(Date.parse(prices.at(-1).start_timestamp)) : undefined;
  return {
    publication_timestamp: lastDay ? swiss(dayStart(addDays(lastDay, -1)) + 14 * 3_600_000) : '',
    prices,
  };
}
