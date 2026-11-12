// -----------------------------------------------------------------------------
// The integration: keeps the Vario prices per local day in memory and in
// /data, asks the Groupe E API only for the days it lacks, feeds the two
// calendars, and answers the delegated pricing of the core from memory only
// (no network on that path: a missing price fails the request, the core
// retries later, and the day is asked from the API in the background).
//
// When the API is asked: at the first start, the last 35 days; then the next
// day from 15:00 Swiss time (Groupe E publishes it at about 14:50), again
// every 30 minutes until it is complete; a past day answered empty or partly
// once a day; a day a pricing request lacked, at most a minute after the last
// request. Nothing else: a complete day is never asked again, a restart or a
// reconnection never asks sooner (the time of the attempt is in /data first).
//
// Clocks: the injected timers schedule within the process (Node timers are
// monotonic) and never sleep more than an hour, so a wall clock that jumps is
// caught up; `now` (wall) gives the local day and hour, and dates /data.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  API_URL,
  BACKFILL_DAYS,
  CALENDAR_AHEAD_DAYS,
  CALENDAR_BATCH,
  CALENDAR_TIMEOUT,
  CALENDARS,
  CURRENCY,
  EMPTY_RETRY,
  KEEP_DAYS,
  KINDS,
  MAX_ANSWER_BYTES,
  MAX_DAYS_PER_REQUEST,
  MAX_RETRY,
  MAX_SLEEP,
  MAX_WANTED_DAYS,
  MIN_GAP,
  PAUSE_DEFAULT,
  PAUSE_MAX,
  PAUSE_MIN,
  PUBLICATION_HOUR,
  RETIRED_RETRY,
  RETRY_STEPS,
  SAVE_TIMEOUT,
  STATUS_TIMEOUT,
  STORE_RETRY,
  TEMPLATES,
  WAIT_PUBLICATION,
} from './constants.js';
import { DataError, dayRecord, parseAnswer, restoreDay, sameDay } from './data.js';
import { SourceError, getJson } from './http.js';
import { T } from './i18n.js';
import { PricingError, contractInputs, currentPrice, intervalCosts } from './tariff.js';
import {
  DAY_PATTERN,
  HOUR,
  QUARTER_HOUR,
  addDays,
  dayOf,
  dayStart,
  daysBetween,
  zurich,
} from './time.js';

const realTimers = { setTimeout, clearTimeout };

/** A wall date read from /data: a finite number not in the future, else undefined. */
const pastDate = (value, now) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : undefined;

/** A short fingerprint of what a calendar received for a day (prices only). */
const signature = (values) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);

/** The local hour PUBLICATION_HOUR of `day`, whatever its length. */
function publicationTime(day) {
  let t = dayStart(day) + PUBLICATION_HOUR * HOUR;
  // A day of a clock change starts with a 23- or 25-hour offset: corrected on the wall clock.
  t += (PUBLICATION_HOUR - zurich(t).hour) * HOUR;
  return t;
}

const ERRORS = [
  'rate_limited',
  'server',
  'retired',
  'http',
  'network',
  'timeout',
  'too_large',
  'invalid',
];

export class App {
  constructor({
    gladys,
    logger = console,
    now = Date.now,
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    /** local day -> { start, integrated: [], grid: [], known } */
    this.days = new Map();
    /** local day -> wall time of the last answer that left it incomplete */
    this.incomplete = new Map();
    /** Days a pricing request lacked (older than the backfill): asked on demand. */
    this.wanted = new Set();
    /** kind -> { day -> signature } of what each calendar received. */
    this.sent = { integrated: {}, grid: {} };
    /** kind -> the code of the last failed calendar publication ('refused', 'error'). */
    this.calendarIssue = {};
    this.meta = {
      attemptAt: undefined,
      checkedAt: undefined,
      failures: 0,
      pausedUntil: undefined,
      publication: undefined,
    };
    this.lastError = undefined;
    this.loaded = false;
    this.loading = undefined;
    this.timer = undefined;
    this.storeTimer = undefined;
    this.checking = undefined;
    this.publishing = undefined;
    this.running = false;
    this.generation = 0;
    /** contract id -> { invalid } */
    this.contracts = new Map();
    this.lastStatus = undefined;
    this.statusJob = Promise.resolve();
    this.saving = undefined;
    /** Why the last write of /data failed ('write', 'timeout'), undefined when it worked. */
    this.dataError = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Connected to Gladys (first time or again): load /data once, schedule, republish the status. */
  async start() {
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.lastStatus = undefined;
    await this.loading?.catch(() => {});
    if (gen !== this.generation) return;
    if (!this.loaded) {
      this.publishStatus(false, T.starting);
      await this.load(gen);
      return;
    }
    this.publishStatus();
    // A check of the previous connection may still run: the schedule resumes after it.
    const resume = () => {
      if (gen === this.generation && this.running && !this.timer && !this.checking) {
        this.tick(gen);
      }
    };
    if (this.checking) this.checking.then(resume, resume);
    else resume();
    await this.refreshContracts(gen);
    // What the calendars missed while disconnected: no request to the API for that.
    await this.publishCalendars(gen);
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    await this.checking?.catch(() => {});
    await this.publishing?.catch(() => {});
  }

  clearTimers() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.timer = undefined;
    this.storeTimer = undefined;
  }

  /** Every pending piece of work (tests). */
  async idle() {
    for (let i = 0; i < 10; i += 1) {
      await this.loading;
      await this.checking;
      await this.publishing;
      await this.statusJob;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // --- /data ----------------------------------------------------------------------

  /** Reads /data once; unreadable: read again every 10 s, nothing asked meanwhile. */
  async load(gen) {
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = undefined;
    this.loading = (async () => {
      const result = await this.store.load();
      if (gen !== this.generation || !this.running) return;
      if (result.status === 'unreadable') {
        this.logger.warn('/data unreadable: read again in 10 s');
        this.publishStatus(false, T.storeUnreadable);
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = undefined;
          if (gen === this.generation && this.running && !this.loading) {
            this.load(gen).catch((err) => this.logger.error('Load failed', err));
          }
        }, STORE_RETRY);
        return;
      }
      if (result.status === 'ok') this.restore(result.data);
      this.loaded = true;
      this.publishStatus();
      this.tick(gen);
      await this.refreshContracts(gen);
      await this.publishCalendars(gen);
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** The state of /data, each part checked; a part that does not read is dropped. */
  restore(data) {
    const now = this.now();
    this.meta.attemptAt = pastDate(data.attemptAt, now);
    this.meta.checkedAt = pastDate(data.checkedAt, now);
    this.meta.failures =
      Number.isInteger(data.failures) && data.failures >= 0 && data.failures < 1000
        ? data.failures
        : 0;
    // A pause longer than its maximum is not ours: ignored.
    this.meta.pausedUntil =
      typeof data.pausedUntil === 'number' &&
      data.pausedUntil > now &&
      data.pausedUntil <= now + PAUSE_MAX
        ? data.pausedUntil
        : undefined;
    this.meta.publication =
      typeof data.publication === 'string' && Number.isFinite(Date.parse(data.publication))
        ? new Date(Date.parse(data.publication)).toISOString()
        : undefined;
    this.lastError = ERRORS.includes(data.lastError) ? data.lastError : undefined;
    const today = dayOf(now);
    const oldest = addDays(today, -KEEP_DAYS);
    const newest = addDays(today, 2);
    const days = data.days && typeof data.days === 'object' ? data.days : {};
    for (const [day, value] of Object.entries(days)) {
      if (!DAY_PATTERN.test(day) || day < oldest || day > newest) continue;
      const record = restoreDay(day, value);
      if (record && record.known > 0) this.days.set(day, record);
      else this.logger.warn(`Stored prices for ${day} unusable: asked again`);
    }
    const incomplete =
      data.incomplete && typeof data.incomplete === 'object' ? data.incomplete : {};
    for (const [day, at] of Object.entries(incomplete)) {
      const when = pastDate(at, now);
      if (DAY_PATTERN.test(day) && when !== undefined) this.incomplete.set(day, when);
    }
    for (const kind of KINDS) {
      const sent = data.sent?.[kind];
      if (!sent || typeof sent !== 'object') continue;
      for (const [day, sig] of Object.entries(sent)) {
        if (DAY_PATTERN.test(day) && typeof sig === 'string' && /^[0-9a-f]{16}$/.test(sig)) {
          this.sent[kind][day] = sig;
        }
      }
    }
  }

  stateToSave() {
    const days = {};
    for (const [day, record] of [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      days[day] = { integrated: record.integrated, grid: record.grid };
    }
    return {
      ...this.meta,
      lastError: this.lastError,
      days,
      incomplete: Object.fromEntries(this.incomplete),
      sent: this.sent,
    };
  }

  /**
   * One write at a time, bounded in time: a write that hangs counts as a
   * failed one (the data stays in memory) and the next saves are skipped
   * until it ends. Never throws.
   */
  async save() {
    if (this.saving) {
      this.dataError = 'timeout';
      return false;
    }
    let timer;
    const job = Promise.resolve().then(() => this.store.save(this.stateToSave()));
    this.saving = job.then(
      () => {},
      () => {},
    );
    this.saving.then(() => {
      this.saving = undefined;
    });
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), SAVE_TIMEOUT);
    });
    try {
      const result = await Promise.race([job.then(() => 'ok'), late]);
      this.dataError = result === 'ok' ? undefined : 'timeout';
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      this.dataError = 'write';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.dataError === 'timeout') this.logger.warn('Writing /data takes too long: skipped');
    return this.dataError === undefined;
  }

  // --- What to ask, and when --------------------------------------------------------

  /** The last day Groupe E should have published at `now`: tomorrow from 15:00, else today. */
  lastExpected(now) {
    const today = dayOf(now);
    return now >= publicationTime(today) ? addDays(today, 1) : today;
  }

  /** A day held whole. */
  complete(day) {
    const record = this.days.get(day);
    return Boolean(record) && record.known === record.integrated.length;
  }

  /**
   * The days to ask at `now` (most recent first), and when the plan changes
   * by itself: `{ days, wake }`. A day answered incomplete waits 30 minutes
   * (today, tomorrow) or a day (a past one) before it is asked again.
   */
  plan(now) {
    const today = dayOf(now);
    const last = this.lastExpected(now);
    const candidates = new Set(daysBetween(addDays(today, 1 - BACKFILL_DAYS), last));
    for (const day of this.wanted) candidates.add(day);
    const days = [];
    let wake = last === today ? publicationTime(today) : publicationTime(addDays(today, 1));
    for (const day of [...candidates].sort().reverse()) {
      if (this.complete(day)) continue;
      const at = this.incomplete.get(day);
      if (at !== undefined) {
        const again = at + (day >= today ? WAIT_PUBLICATION : EMPTY_RETRY);
        if (again > now) {
          wake = Math.min(wake, again);
          continue;
        }
      }
      days.push(day);
    }
    return { days, wake };
  }

  /** The earliest the next request may leave, on one reading of the wall clock. */
  dueAt(now) {
    const { attemptAt, failures, pausedUntil } = this.meta;
    let due = now;
    if (attemptAt !== undefined) {
      let gap = MIN_GAP;
      if (this.lastError === 'retired') gap = RETIRED_RETRY;
      else if (failures > 0) gap = this.interval(failures);
      due = attemptAt + gap;
    }
    if (pausedUntil !== undefined && pausedUntil > due) due = pausedUntil;
    return due;
  }

  interval(failures) {
    return Math.min(RETRY_STEPS[Math.min(failures, RETRY_STEPS.length) - 1], MAX_RETRY);
  }

  /** Decides now: a check when a day is lacking and the gap allows it, else sleeps until it may. */
  tick(gen) {
    if (gen !== this.generation || !this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.checking) return;
    const now = this.now();
    const { days, wake } = this.plan(now);
    let at = wake;
    if (days.length > 0) {
      const due = this.dueAt(now);
      if (due <= now) {
        this.check(gen, days).catch((err) => this.logger.error('Check failed', err));
        return;
      }
      at = due;
    }
    this.sleep(gen, Math.min(Math.max(0, at - now), MAX_SLEEP));
  }

  sleep(gen, ms) {
    this.retryAt = this.now() + ms;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.tick(gen);
    }, ms);
  }

  /** A pricing request lacked these days: asked soon (never sooner than the gap). */
  want(days) {
    const today = dayOf(this.now());
    const oldest = addDays(today, -KEEP_DAYS);
    for (const day of days) {
      if (DAY_PATTERN.test(day) && day >= oldest && day <= today && !this.complete(day)) {
        this.wanted.add(day);
      }
    }
    // The most recent ones only: an old contract is caught up a window at a time.
    const kept = [...this.wanted].sort().reverse().slice(0, MAX_WANTED_DAYS);
    this.wanted = new Set(kept);
    if (this.running && this.loaded && !this.checking) this.tick(this.generation);
  }

  // --- Asking the API ------------------------------------------------------------

  async check(gen, days) {
    if (this.checking || gen !== this.generation || !this.running) return this.checking;
    const job = this.runCheck(gen, days).finally(() => {
      // Only this check: a newer one started by the schedule stays tracked.
      if (this.checking === job) this.checking = undefined;
    });
    this.checking = job;
    return job;
  }

  /** Contiguous runs of at most 7 days, most recent first. */
  static chunks(days) {
    const sorted = [...days].sort().reverse();
    const runs = [];
    for (const day of sorted) {
      const run = runs[runs.length - 1];
      if (run && run.length < MAX_DAYS_PER_REQUEST && addDays(day, 1) === run[run.length - 1]) {
        run.push(day);
      } else runs.push([day]);
    }
    return runs.map((run) => run.reverse());
  }

  async runCheck(gen, days) {
    // The attempt is dated in /data before the first request: a restart in
    // the middle never asks again sooner.
    this.meta.attemptAt = this.now();
    await this.save();
    if (gen !== this.generation) return;
    let failure;
    let changed = false;
    for (const run of App.chunks(days)) {
      const from = dayStart(run[0]);
      const to = dayStart(addDays(run[run.length - 1], 1));
      const url = `${API_URL}?start_timestamp=${encodeURIComponent(
        new Date(from).toISOString(),
      )}&end_timestamp=${encodeURIComponent(new Date(to).toISOString())}`;
      try {
        const { json } = await getJson(url, {
          limit: MAX_ANSWER_BYTES,
          fetchImpl: this.fetchImpl,
          now: this.now,
        });
        let answer;
        try {
          answer = parseAnswer(json);
        } catch (err) {
          if (!(err instanceof DataError)) throw err;
          throw new SourceError('invalid', `The Groupe E tariff API answer: ${err.message}`);
        }
        if (gen !== this.generation) return;
        if (this.take(run, answer)) changed = true;
      } catch (err) {
        if (gen !== this.generation) return;
        if (!(err instanceof SourceError)) throw err;
        // The other runs wait for the next attempt: never a storm on a failing API.
        failure = err;
        break;
      }
    }
    const now = this.now();
    if (!failure) {
      this.meta.failures = 0;
      this.meta.pausedUntil = undefined;
      this.meta.checkedAt = now;
      this.lastError = undefined;
    } else {
      this.meta.failures += 1;
      this.lastError = failure.code;
      this.logger.warn(`Groupe E check failed: ${failure.message}`);
      if (failure.code === 'rate_limited') {
        const pause = Math.min(Math.max(failure.retryAfter ?? PAUSE_DEFAULT, PAUSE_MIN), PAUSE_MAX);
        this.meta.pausedUntil = now + pause;
      }
    }
    this.prune(now);
    await this.save();
    if (gen !== this.generation) return;
    // The back-off, the pause and the retired gap are decided by dueAt() from
    // the time of this attempt, on a timer: a check never chains into the next
    // one without going through the schedule.
    this.checking = undefined;
    this.sleep(gen, 0);
    this.publishStatus();
    if (changed || Object.keys(this.calendarIssue).length > 0) await this.publishCalendars(gen);
  }

  /**
   * Takes the quarters of one answer for the days of `run` (only those: a
   * quarter of another day is not read); a quarter held
   * and absent from the answer is kept (an answer never erases a price).
   * Returns whether a day changed.
   */
  take(run, answer) {
    const now = this.now();
    let changed = false;
    if (answer.refused > 0) {
      this.logger.warn(`Groupe E answer: ${answer.refused} quarter hours unreadable, left unknown`);
    }
    for (const day of run) {
      const fresh = dayRecord(day, answer.quarters);
      const held = this.days.get(day);
      let record = fresh;
      if (held) {
        record = { start: fresh.start, integrated: [], grid: [], known: 0 };
        for (let k = 0; k < fresh.integrated.length; k += 1) {
          const source = fresh.integrated[k] === null ? held : fresh;
          for (const kind of KINDS) record[kind].push(source[kind][k]);
          if (record.integrated[k] !== null) record.known += 1;
        }
      }
      if (record.known > 0 && !sameDay(record, held)) {
        if (held) this.logger.info(`Groupe E prices of ${day} changed`);
        this.days.set(day, record);
        changed = true;
      }
      if (record.known === record.integrated.length) {
        this.incomplete.delete(day);
        this.wanted.delete(day);
      } else {
        this.incomplete.set(day, now);
        // Asked once on demand: a day still lacking comes back with the next pricing request.
        this.wanted.delete(day);
      }
    }
    if (
      answer.publication &&
      (!this.meta.publication || answer.publication > this.meta.publication)
    ) {
      this.meta.publication = answer.publication;
    }
    return changed;
  }

  /** Days older than a year and a month leave memory and /data. */
  prune(now) {
    const oldest = addDays(dayOf(now), -KEEP_DAYS);
    for (const day of this.days.keys()) if (day < oldest) this.days.delete(day);
    for (const day of this.incomplete.keys()) if (day < oldest) this.incomplete.delete(day);
    for (const kind of KINDS) {
      for (const day of Object.keys(this.sent[kind])) {
        if (day < oldest) delete this.sent[kind][day];
      }
    }
  }

  // --- Calendars ------------------------------------------------------------------

  /**
   * Publishes to each calendar the days it has not received as they are now
   * (the known quarters only, up to 7 days ahead), in batches of 2,000; a
   * failure stops that calendar until the next check or reconnection.
   */
  async publishCalendars(gen) {
    if (this.publishing) return this.publishing;
    const job = this.runPublish(gen).finally(() => {
      if (this.publishing === job) this.publishing = undefined;
    });
    this.publishing = job;
    return job;
  }

  async runPublish(gen) {
    const now = this.now();
    const limit = dayStart(addDays(dayOf(now), CALENDAR_AHEAD_DAYS));
    let any = false;
    for (const kind of KINDS) {
      const pending = [];
      for (const [day, record] of [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (record.start >= limit) continue;
        const sig = signature(record[kind]);
        if (this.sent[kind][day] !== sig) pending.push({ day, record, sig });
      }
      if (pending.length === 0) {
        delete this.calendarIssue[kind];
        continue;
      }
      let batch = [];
      let days = [];
      const flush = async () => {
        if (batch.length === 0) return true;
        const ok = await this.sendCalendar(CALENDARS[kind], batch);
        if (gen !== this.generation) return false;
        if (!ok.sent) {
          this.calendarIssue[kind] = ok.issue;
          return false;
        }
        for (const { day, sig } of days) this.sent[kind][day] = sig;
        any = true;
        batch = [];
        days = [];
        return true;
      };
      let stopped = false;
      for (const item of pending) {
        const entries = [];
        item.record[kind].forEach((price, k) => {
          if (price !== null) {
            entries.push({
              starts_at: new Date(item.record.start + k * QUARTER_HOUR).toISOString(),
              price,
              currency: CURRENCY,
            });
          }
        });
        if (batch.length + entries.length > CALENDAR_BATCH && !(await flush())) {
          stopped = true;
          break;
        }
        batch.push(...entries);
        days.push(item);
      }
      if (!stopped && (await flush())) delete this.calendarIssue[kind];
      if (gen !== this.generation) return;
    }
    if (any) await this.save();
    this.publishStatus();
  }

  /** One calendar batch, bounded in time: `{ sent }` or `{ sent: false, issue }`. Never throws. */
  async sendCalendar(key, entries) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), CALENDAR_TIMEOUT);
    });
    try {
      const job = Promise.resolve().then(() => this.gladys.publishEnergyCalendar(key, entries));
      const result = await Promise.race([job.then(() => 'ok'), late]);
      if (result === 'timeout') {
        job.catch(() => {});
        this.logger.warn(`Calendar ${key}: no answer in time`);
        return { sent: false, issue: 'error' };
      }
      return { sent: true };
    } catch (err) {
      const status = err?.status ?? err?.statusCode;
      this.logger.warn(`Calendar ${key} not fed: ${err?.message ?? err}`);
      return { sent: false, issue: status === 403 ? 'refused' : 'error' };
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Status ---------------------------------------------------------------------

  /**
   * Publishes the status in the background (one at a time, in order, each
   * bounded in time); a state already published is not sent again. Returns
   * the promise of the publication, which never rejects.
   */
  publishStatus(connected, message) {
    let state = { connected, message };
    if (message === undefined) {
      const now = this.now();
      const today = dayOf(now);
      const held = [...this.days.keys()].filter((d) => this.complete(d)).sort();
      const through = held.filter((d) => d >= today).pop();
      const invalid = [...this.contracts.values()].filter((c) => c.invalid).length;
      state = {
        connected: this.complete(today),
        message: T.status({
          todayPartial: this.days.has(today) && !this.complete(today),
          through,
          tomorrowMissing: this.lastExpected(now) > today && !this.complete(addDays(today, 1)),
          publication: this.meta.publication,
          checkedAt: this.meta.checkedAt,
          error: this.lastError,
          retryAt: this.lastError ? this.retryAt : undefined,
          calendars: { ...this.calendarIssue },
          invalid,
          dataError: this.dataError,
        }),
      };
    }
    const key = JSON.stringify(state);
    if (key === this.lastStatus) return this.statusJob;
    this.lastStatus = key;
    this.statusJob = this.statusJob.then(() => this.sendStatus(state));
    return this.statusJob;
  }

  async sendStatus(state) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), STATUS_TIMEOUT);
    });
    try {
      const sent = Promise.resolve().then(() =>
        this.gladys.setConnectionStatus(state.connected, state.message),
      );
      if ((await Promise.race([sent.then(() => 'ok'), late])) === 'timeout') {
        sent.catch(() => {});
        this.logger.warn('Status not published in time');
      }
    } catch (err) {
      this.logger.warn(`Status not published: ${err?.message ?? err}`);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Remembers whether a contract's inputs read (status only). */
  noteContract(contract) {
    if (!contract || (typeof contract.id !== 'string' && typeof contract.id !== 'number')) return;
    if (!Object.values(TEMPLATES).includes(contract.template_key)) return;
    let invalid = false;
    try {
      contractInputs(contract);
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      invalid = true;
    }
    this.contracts.set(String(contract.id), { invalid });
  }

  /** The contracts referencing the templates, read from Gladys (secondary: a failure changes nothing). */
  async refreshContracts(gen) {
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
    } catch (err) {
      this.logger.warn(`Contracts not read: ${err?.message ?? err}`);
      return;
    }
    if (gen !== this.generation || !Array.isArray(list)) return;
    this.contracts.clear();
    for (const contract of list.slice(0, 100)) this.noteContract(contract);
    this.publishStatus();
  }

  // --- Delegated pricing ----------------------------------------------------------

  async energyPrice({ contract, intervals } = {}) {
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    this.noteContract(contract);
    this.publishStatus();
    try {
      return intervalCosts(this.days, contract, intervals);
    } catch (err) {
      if (err instanceof PricingError && err.days) this.want(err.days);
      throw err;
    }
  }

  async energyCurrent({ contract } = {}) {
    this.noteContract(contract);
    this.publishStatus();
    try {
      return currentPrice(this.days, contract, this.now());
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      return { price: null };
    }
  }
}
