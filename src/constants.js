// -----------------------------------------------------------------------------
// Keys shared with the manifest, the data source and the bounds. The manifest
// keys (templates, inputs, calendars) are forever: contracts and users store
// them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-groupe-e-vario/${VERSION} (+https://github.com/LM1LC3N7/gladys-groupe-e-vario)`;

/**
 * The public tariff API of Groupe E, version 2 (the version 1 answers 410
 * Gone since 2026): `?start_timestamp=&end_timestamp=` (ISO 8601), the
 * quarter hours starting inside the window, grid and integrated price in
 * CHF/kWh. A 404 or 410 here means Groupe E retired this version too.
 */
export const API_URL = 'https://api.tariffs.groupe-e.ch/v2/tariffs';

/** Swiss legal time: the Vario days run from local midnight to local midnight. */
export const TIMEZONE = 'Europe/Zurich';
export const CURRENCY = 'CHF';
/** The only unit the API is known to answer; any other one is refused, never converted. */
export const UNIT = 'CHF_kWh';

/** The two prices of each quarter hour: integrated (energy and grid) and grid only. */
export const KINDS = ['integrated', 'grid'];

export const TEMPLATES = {
  integrated: 'groupe-e-vario',
  grid: 'groupe-e-vario-grid',
};
export const CALENDARS = {
  integrated: 'groupe-e-vario',
  grid: 'groupe-e-vario-grid',
};

export const INPUTS = {
  ENERGY: 'energy_chf_kwh',
  SUPPLEMENT: 'supplement_chf_kwh',
  VAT: 'vat_percent',
  FIXED: 'fixed_chf_month',
};
export const INPUT_DEFAULTS = {
  [INPUTS.ENERGY]: 0,
  [INPUTS.SUPPLEMENT]: 0,
  [INPUTS.VAT]: 0,
  [INPUTS.FIXED]: 0,
};
export const INPUT_BOUNDS = {
  [INPUTS.ENERGY]: [0, 2],
  [INPUTS.SUPPLEMENT]: [0, 2],
  [INPUTS.VAT]: [0, 25],
  [INPUTS.FIXED]: [0, 1000],
};
/** The inputs of each template, in the manifest order. */
export const TEMPLATE_INPUTS = {
  integrated: [INPUTS.SUPPLEMENT, INPUTS.VAT, INPUTS.FIXED],
  grid: [INPUTS.ENERGY, INPUTS.SUPPLEMENT, INPUTS.VAT, INPUTS.FIXED],
};

// --- Bounds ------------------------------------------------------------------

export const HTTP_TIMEOUT = 30_000;
/** One request covers at most this many local days (about 700 KB for 7 days). */
export const MAX_DAYS_PER_REQUEST = 7;
/** A 7-day answer is about 115 KB; more is not the published data. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
/** Quarter hours read from one answer (7 days of 100 quarters is 700). */
export const MAX_ENTRIES = 1000;
/** A price beyond ±5 CHF/kWh is not a Vario price: the quarter is refused. */
export const MAX_PRICE = 5;
/** Local days kept in memory and /data (a year and a month). */
export const KEEP_DAYS = 400;
/** Days fetched back from today at the first start (a whole billing period and more). */
export const BACKFILL_DAYS = 35;
/** Older days asked by a pricing request: fetched on demand, this many per check. */
export const MAX_WANTED_DAYS = 62;
/** The /data state file read back at most this size (larger: not ours). */
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
/**
 * The core refuses a cost above 10 CHF per kWh (a hostile-payload guard): a
 * contract whose inputs would get there is refused by the module with a reason.
 */
export const MAX_COST_PER_KWH = 10;
/** Intervals in one pricing request (the core sends 1,488 at most). */
export const MAX_INTERVALS = 2000;
/** Entries in one calendar publication (the core takes 2,000 at most). */
export const CALENDAR_BATCH = 2000;
/** The core takes calendar entries up to 7 days ahead. */
export const CALENDAR_AHEAD_DAYS = 7;
/** The quarters looked ahead for the next price change (2 days). */
export const LOOKAHEAD = 2 * 100;

// --- Schedule ----------------------------------------------------------------

/** Groupe E publishes the next day at about 15:00 (Swiss time): looked for from then on. */
export const PUBLICATION_HOUR = 15;
/** The next day not published yet: asked again every 30 minutes. */
export const WAIT_PUBLICATION = 30 * 60_000;
/** A day the API answered empty (before the history, a gap): asked again a day later. */
export const EMPTY_RETRY = 24 * 60 * 60_000;
/** After a failed check: 5, 15, 30, 60 minutes, then every 3 hours (MAX_RETRY caps the steps). */
export const RETRY_STEPS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
export const MAX_RETRY = 6 * 60 * 60_000;
/** The version retired (404, 410): asked again every 6 hours, the update of the module is due. */
export const RETIRED_RETRY = 6 * 60 * 60_000;
/** A 429: its Retry-After within these bounds (10 minutes when absent). */
export const PAUSE_MIN = 60_000;
export const PAUSE_MAX = 6 * 60 * 60_000;
export const PAUSE_DEFAULT = 10 * 60_000;
/** A pricing request missing a day never brings a check sooner than this after the last one. */
export const MIN_GAP = 60_000;
/** /data unreadable (not missing): read again on this period. */
export const STORE_RETRY = 10_000;
/** A write of /data longer than this counts as failed (the data stays in memory). */
export const SAVE_TIMEOUT = 10_000;
/** A status publication longer than this is given up (the next one goes on). */
export const STATUS_TIMEOUT = 10_000;
/** A calendar publication longer than this is given up (retried at the next check). */
export const CALENDAR_TIMEOUT = 20_000;
/** The schedule never sleeps longer than this (a wall clock that jumps is caught up). */
export const MAX_SLEEP = 60 * 60_000;
