// -----------------------------------------------------------------------------
// Reading the answers of the Groupe E tariff API (v2), never trusted:
//
//   { "publication_timestamp": "2026-11-10T14:50:43+01:00",
//     "prices": [ { "start_timestamp": "2026-11-11T00:00:00+01:00",
//                   "end_timestamp":   "2026-11-11T00:15:00+01:00",
//                   "grid":       [ { "unit": "CHF_kWh", "value": 0.0821 } ],
//                   "integrated": [ { "unit": "CHF_kWh", "value": 0.2016 } ] }, … ] }
//
// A quarter hour is kept only when its start and end are exact ISO instants
// 15 minutes apart on the quarter, and both prices are finite numbers in
// CHF_kWh within ±5 CHF. Anything else (a string, null, another unit, a
// duplicate start with another price) leaves that quarter unknown: never a
// zero, never a guess. Linear, bounded in entries, no prototype involved.
// -----------------------------------------------------------------------------

import { KINDS, MAX_ENTRIES, MAX_PRICE, UNIT } from './constants.js';
import { QUARTER_HOUR, dayOf, dayStart, quartersOf } from './time.js';

export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/;

/** An exact ISO instant with its offset, as epoch ms; undefined otherwise. */
export function instant(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/** The CHF/kWh price of one list (`grid`, `integrated`); undefined when not readable. */
function priceOf(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 4) return undefined;
  const found = list.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item) && item.unit === UNIT,
  );
  if (found.length !== 1) return undefined;
  const { value } = found[0];
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_PRICE
    ? value
    : undefined;
}

/**
 * The quarters of an answer: `{ publication, quarters: Map(start -> { integrated,
 * grid }), refused }`. Throws a DataError when the envelope is not the API's.
 */
export function parseAnswer(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new DataError('not a tariff answer');
  }
  const { prices } = json;
  if (!Array.isArray(prices)) throw new DataError('no price list');
  if (prices.length > MAX_ENTRIES) throw new DataError('too many quarter hours');
  const raw = json.publication_timestamp;
  const publication = instant(raw) !== undefined ? new Date(instant(raw)).toISOString() : undefined;
  const quarters = new Map();
  const conflicts = new Set();
  let refused = 0;
  for (const entry of prices) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refused += 1;
      continue;
    }
    const start = instant(entry.start_timestamp);
    const end = instant(entry.end_timestamp);
    if (start === undefined || end !== start + QUARTER_HOUR || start % QUARTER_HOUR !== 0) {
      refused += 1;
      continue;
    }
    const slot = {};
    for (const kind of KINDS) slot[kind] = priceOf(entry[kind]);
    if (KINDS.some((kind) => slot[kind] === undefined)) {
      refused += 1;
      continue;
    }
    const held = quarters.get(start);
    if (held && KINDS.some((kind) => held[kind] !== slot[kind])) {
      // Two prices for one quarter: neither is believed.
      conflicts.add(start);
      refused += 1;
      continue;
    }
    quarters.set(start, slot);
  }
  for (const start of conflicts) quarters.delete(start);
  return { publication, quarters, refused };
}

/**
 * One local day out of the quarters read: `{ start, integrated: [], grid: [],
 * known }`, the arrays as long as the day (92, 96 or 100), null where a
 * quarter is unknown. `known` counts the quarters held.
 */
export function dayRecord(day, quarters) {
  const start = dayStart(day);
  const length = quartersOf(day);
  const record = { start, integrated: [], grid: [], known: 0 };
  for (let k = 0; k < length; k += 1) {
    const slot = quarters.get(start + k * QUARTER_HOUR);
    for (const kind of KINDS) record[kind].push(slot ? slot[kind] : null);
    if (slot) record.known += 1;
  }
  return record;
}

/** A day record read back from /data, checked as strictly as an answer. */
export function restoreDay(day, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const length = quartersOf(day);
  const record = { start: dayStart(day), integrated: [], grid: [], known: 0 };
  for (const kind of KINDS) {
    const list = value[kind];
    if (!Array.isArray(list) || list.length !== length) return undefined;
    for (const v of list) {
      if (v === null) record[kind].push(null);
      else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_PRICE) {
        record[kind].push(v);
      } else return undefined;
    }
  }
  for (let k = 0; k < length; k += 1) {
    // A quarter is known when both of its prices are.
    if ((record.integrated[k] === null) !== (record.grid[k] === null)) return undefined;
    if (record.integrated[k] !== null) record.known += 1;
  }
  return record;
}

/** The days touched by a set of instants (the local days of the quarters). */
export const daysOfQuarters = (quarters) => new Set([...quarters.keys()].map(dayOf));

/** Two records hold the same prices. */
export function sameDay(a, b) {
  if (!a || !b) return false;
  return KINDS.every(
    (kind) => a[kind].length === b[kind].length && a[kind].every((v, i) => v === b[kind][i]),
  );
}
