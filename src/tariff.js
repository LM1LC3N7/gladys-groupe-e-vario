// -----------------------------------------------------------------------------
// Delegated pricing of the two templates, from the prices held in memory only
// (never the network on this path: a retry of the core gets the same answer).
//
// The core sends 30-minute intervals; Vario prices change every quarter hour,
// so an interval is priced as its two quarters, half of its energy each (the
// core's own convention for 15-minute calendars). A quarter whose price is not
// known makes the whole request fail (the core retries later, the intervals
// stay without a cost): never a zero, never a guess.
//
// Per kWh: the Vario price (integrated, or grid plus the energy price typed),
// plus the supplement typed, then the VAT typed on the whole. The core refuses
// a negative cost: an interval whose total is negative (a negative published
// price) is counted 0 and labelled so.
// -----------------------------------------------------------------------------

import {
  INPUT_BOUNDS,
  INPUT_DEFAULTS,
  INPUTS,
  MAX_COST_PER_KWH,
  MAX_INTERVALS,
  TEMPLATES,
  TEMPLATE_INPUTS,
} from './constants.js';
import { QUARTER_HOUR, dayOf } from './time.js';

export class PricingError extends Error {
  constructor(message, { days } = {}) {
    super(message);
    this.name = 'PricingError';
    /** The local days whose prices are missing, when that is the cause. */
    this.days = days;
  }
}

const KIND_OF_TEMPLATE = Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [v, k]));

const NUMBER = /^-?\d{1,6}(\.\d{1,9})?$/;

/** A number input: empty takes the default; anything else must be a number in bounds. */
function numberInput(inputs, key) {
  let value = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return INPUT_DEFAULTS[key];
  }
  if (typeof value === 'string' && NUMBER.test(value.trim())) value = Number(value.trim());
  const [min, max] = INPUT_BOUNDS[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PricingError(`The contract input ${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** The template kind and the inputs of a contract, checked. */
export function contractInputs(contract) {
  const kind = KIND_OF_TEMPLATE[contract?.template_key];
  if (!kind) throw new PricingError('Unknown contract template');
  const raw = contract.inputs;
  const inputs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const values = {};
  for (const key of TEMPLATE_INPUTS[kind]) values[key] = numberInput(inputs, key);
  return {
    kind,
    energy: kind === 'grid' ? values[INPUTS.ENERGY] : 0,
    supplement: values[INPUTS.SUPPLEMENT],
    vat: values[INPUTS.VAT],
  };
}

/** The published price (CHF/kWh) of `kind` for the quarter starting at `t`; undefined when unknown. */
export function priceAt(days, kind, t) {
  const record = days.get(dayOf(t));
  if (!record) return undefined;
  const index = (t - record.start) / QUARTER_HOUR;
  const value = record[kind][index];
  return typeof value === 'number' ? value : undefined;
}

/** CHF per kWh, VAT included, of one quarter: undefined when its price is unknown. */
function unitPrice(days, inputs, t) {
  const published = priceAt(days, inputs.kind, t);
  if (published === undefined) return undefined;
  return (published + inputs.energy + inputs.supplement) * (1 + inputs.vat / 100);
}

const LABELS = { integrated: 'Vario', grid: 'Vario grid' };

/** One cost per interval, or a PricingError (the core then retries the whole request). */
export function intervalCosts(days, contract, intervals) {
  const inputs = contractInputs(contract);
  if (!Array.isArray(intervals) || intervals.length > MAX_INTERVALS) {
    throw new PricingError('Invalid pricing request');
  }
  const missing = new Set();
  const costs = [];
  for (const interval of intervals) {
    const t = Date.parse(interval?.starts_at);
    const kwh = interval?.kwh;
    if (typeof interval?.starts_at !== 'string' || !Number.isFinite(t) || t % QUARTER_HOUR !== 0) {
      throw new PricingError('Invalid interval start');
    }
    if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
      throw new PricingError('Invalid interval energy');
    }
    let vario = 0;
    let known = true;
    for (const q of [t, t + QUARTER_HOUR]) {
      const published = priceAt(days, inputs.kind, q);
      if (published === undefined) {
        missing.add(dayOf(q));
        known = false;
      } else vario += (kwh / 2) * published;
    }
    if (!known) continue;
    const energy = kwh * inputs.energy;
    const supplement = kwh * inputs.supplement;
    const vat = (vario + energy + supplement) * (inputs.vat / 100);
    const total = vario + energy + supplement + vat;
    if (total > kwh * MAX_COST_PER_KWH) {
      throw new PricingError(
        `The price of the contract exceeds ${MAX_COST_PER_KWH} CHF/kWh (the Gladys limit): check its inputs`,
      );
    }
    if (total < 0) {
      costs.push({
        starts_at: interval.starts_at,
        cost: 0,
        label: `${LABELS[inputs.kind]} (negative price, counted 0)`,
      });
      continue;
    }
    const components = { vario };
    if (inputs.kind === 'grid') components.energy = energy;
    components.supplement = supplement;
    components.vat = vat;
    costs.push({
      starts_at: interval.starts_at,
      cost: total,
      components,
      label: LABELS[inputs.kind],
    });
  }
  if (missing.size > 0) {
    const days = [...missing].sort();
    throw new PricingError(`No Groupe E Vario price yet for ${days.slice(0, 3).join(', ')}`, {
      days,
    });
  }
  return costs;
}

/**
 * The price now and the next one: `{ price, valid_until, next_price, label,
 * next_label }` (CHF/kWh, VAT included), `{ price: null }` when the current
 * quarter is unknown. The next price is the next quarter's (null when not
 * published yet).
 */
export function currentPrice(days, contract, now) {
  const inputs = contractInputs(contract);
  const start = Math.floor(now / QUARTER_HOUR) * QUARTER_HOUR;
  const price = unitPrice(days, inputs, start);
  if (price === undefined) return { price: null };
  const next = start + QUARTER_HOUR;
  const nextPrice = unitPrice(days, inputs, next);
  return {
    price,
    valid_until: new Date(next).toISOString(),
    next_price: nextPrice === undefined ? null : nextPrice,
    label: LABELS[inputs.kind],
    ...(nextPrice === undefined ? {} : { next_label: LABELS[inputs.kind] }),
  };
}
