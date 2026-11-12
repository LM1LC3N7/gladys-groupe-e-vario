// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout, the
// module's User-Agent and a body read up to a bound, never whole. Only the
// Groupe E tariff API is ever asked; no redirect is followed. Taken from
// gladys-netzentgelte-14a (approved), itself from gladys-entsoe.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';

export class SourceError extends Error {
  /** `code`: 'rate_limited', 'server', 'retired', 'http', 'network', 'timeout', 'too_large', 'invalid'. */
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  // An HTTP date names its day and month: a bare number or sign is not one.
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The body as text, refused past `limit` bytes (read in chunks, never whole). */
export async function readBounded(response, limit) {
  const tooLarge = () => new SourceError('too_large', `The answer is larger than ${limit} bytes`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return timedOut
    ? new SourceError('timeout', 'The Groupe E tariff API did not answer in time')
    : new SourceError('network', 'The Groupe E tariff API is unreachable (network error)');
}

/** GET the JSON answer of `url`: resolves `{ json }`, throws a SourceError otherwise. */
export async function getJson(
  url,
  { limit, fetchImpl = globalThis.fetch, now = Date.now, timeout = HTTP_TIMEOUT } = {},
) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, timeout)),
      redirect: 'error',
    });
  } catch (err) {
    throw networkError(err);
  }
  const { status } = response;
  if (status === 200) {
    let body;
    try {
      body = await readBounded(response, limit);
    } catch (err) {
      throw err instanceof SourceError ? err : networkError(err);
    }
    try {
      return { json: JSON.parse(body) };
    } catch {
      throw new SourceError('invalid', 'The Groupe E tariff API answered something else than JSON');
    }
  }
  await response.body?.cancel?.().catch(() => {});
  if (status === 429) {
    // An HTTP date is compared to the server's own clock (its Date header) when it gives one.
    const served = Date.parse(response.headers?.get?.('date') ?? '');
    throw new SourceError('rate_limited', 'The Groupe E tariff API asked to slow down (429)', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        Number.isFinite(served) ? served : now(),
      ),
    });
  }
  if (status === 404 || status === 410) {
    // The version 1 answers 410 since its retirement: the same for this one means an update is due.
    throw new SourceError('retired', `The Groupe E tariff API v2 answered ${status} (retired?)`, {
      status,
    });
  }
  if (status >= 500) {
    throw new SourceError('server', `The Groupe E tariff API answered ${status}`, { status });
  }
  throw new SourceError('http', `The Groupe E tariff API answered ${status}`, { status });
}
