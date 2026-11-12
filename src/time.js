// -----------------------------------------------------------------------------
// Swiss legal time (Europe/Zurich): the Vario prices are published per local
// day, from local midnight to local midnight. A day has 96 quarter hours, 92 on
// the spring change (last Sunday of March) and 100 on the autumn one (last
// Sunday of October). Pure.
// -----------------------------------------------------------------------------

import { TIMEZONE } from './constants.js';

export const MINUTE = 60_000;
export const QUARTER_HOUR = 15 * MINUTE;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const two = (n) => String(n).padStart(2, '0');

/** `{ year, month, day, hour, minute }` of the instant `t` (epoch ms) in Zurich. */
export function zurich(t) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(t))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return parts;
}

/** The local day `YYYY-MM-DD` of the instant `t`. */
export function dayOf(t) {
  const p = zurich(t);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

export const DAY_PATTERN = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The day `n` days after `day` (calendar days, whatever their length). */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** The instant of the local midnight starting `day` (Zurich is UTC+1 or UTC+2 then). */
export function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const offset of [1, 2]) {
    const t = Date.UTC(y, m - 1, d) - offset * HOUR;
    const p = zurich(t);
    if (p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0) return t;
  }
  throw new RangeError(`No local midnight for ${day}`);
}

/** The quarter hours of a local day: 96, 92 or 100. */
export const quartersOf = (day) => (dayStart(addDays(day, 1)) - dayStart(day)) / QUARTER_HOUR;

/** The days from `first` to `last`, both included (none when `last` is before `first`). */
export function daysBetween(first, last) {
  const days = [];
  for (let day = first; day <= last && days.length < 10_000; day = addDays(day, 1)) days.push(day);
  return days;
}

/** `YYYY-MM-DD HH:MM` in Zurich, for the texts shown. */
export function localText(t) {
  const p = zurich(t);
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
