/**
 * Shared HTTP client for Google direct-API adapters (gmail/gdrive/gcal).
 *
 * Handles:
 *   - Bearer auth (token passed in by adapter)
 *   - Rate limit detection: 429 + 403 quotaExceeded family + 5xx
 *   - Retry-After header honoring (Google sends seconds)
 *   - Bounded exponential backoff with jitter for transient errors
 *   - GoogleRateLimitError surfaced to the sync runner with a
 *     `retry_after_seconds` hint when the in-process retries can't fix it
 *
 * Policy:
 *   - Short transient errors (429 + Retry-After ≤ 60s, 503, 5xx) → in-process
 *     retry up to MAX_RETRIES with backoff
 *   - Daily-quota errors (reason='dailyLimitExceeded' or Retry-After > 60s)
 *     → throw GoogleRateLimitError immediately with the recovery hint
 *     (caller / sync runner decides whether to defer the whole connector)
 */

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_INLINE_RETRY_SECONDS = 60;

// Quota error reasons surfaced in Google's JSON error body.
const DAILY_QUOTA_REASONS = new Set([
  'dailyLimitExceeded',
  'dailyLimitExceededUnreg',
]);
const TRANSIENT_QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

export interface GoogleFetchOptions {
  /** Override default GET method. */
  method?: string;
  /** Treat the body as plain text instead of JSON (used for files.export). */
  asText?: boolean;
  /** Extra headers to merge (Authorization is set automatically). */
  headers?: Record<string, string>;
  /** Optional request body for POST/PATCH/etc. */
  body?: string | Record<string, unknown>;
  /** Override max retries (default 3). */
  maxRetries?: number;
  /** A label used in error messages (e.g. 'Gmail', 'Drive', 'Calendar'). */
  label?: string;
}

/**
 * Thrown when the request is rate-limited in a way that needs longer
 * recovery than an in-process retry can absorb. Carries a hint for how
 * long to wait before the next attempt.
 */
export class GoogleRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retry_after_seconds: number,
    public readonly status: number,
    public readonly reason: string | null,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GoogleRateLimitError';
  }
}

interface QuotaInfo {
  reason: string | null;
  retryAfterSeconds: number;
  isDaily: boolean;
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  // Either seconds (number) or HTTP-date.
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber);
  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return 0;
  return Math.max(0, Math.floor((asDate - Date.now()) / 1000));
}

function readQuotaInfo(status: number, bodyText: string, retryAfterHeader: string | null): QuotaInfo {
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  let reason: string | null = null;
  let isDaily = false;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { errors?: Array<{ reason?: string; domain?: string }>; status?: string };
    };
    const first = parsed?.error?.errors?.[0];
    if (first?.reason) reason = first.reason;
    if (reason && DAILY_QUOTA_REASONS.has(reason)) isDaily = true;
  } catch {
    /* not JSON */
  }
  // Heuristic fallback for older API responses that don't surface reason.
  if (!reason && /daily limit/i.test(bodyText)) {
    reason = 'dailyLimitExceeded';
    isDaily = true;
  }
  // 429 with a long Retry-After also signals daily-ish recovery.
  if (!isDaily && retryAfterSeconds > MAX_INLINE_RETRY_SECONDS) {
    isDaily = true;
  }
  return { reason, retryAfterSeconds, isDaily };
}

function backoffMs(attempt: number): number {
  // Full-jitter backoff: random in [0, base * 2^attempt], capped at 30s.
  const ceiling = Math.min(30_000, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function fetchGoogle<T = unknown>(
  url: string,
  accessToken: string,
  opts: GoogleFetchOptions = {},
): Promise<T> {
  const { method = 'GET', asText = false, headers = {}, body, label = 'Google' } = opts;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: asText ? 'text/plain' : 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) {
    if (typeof body === 'string') {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] ??= 'application/json';
    }
  }

  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network error — retry like a transient 5xx.
      if (attempt < maxRetries) {
        const wait = backoffMs(attempt);
        console.warn(`[${label}] fetch network error (attempt ${attempt + 1}/${maxRetries}); backoff ${wait}ms: ${err instanceof Error ? err.message : String(err)}`);
        attempt += 1;
        await sleep(wait);
        continue;
      }
      throw err;
    }

    if (res.ok) {
      return (asText ? await res.text() : await res.json()) as T;
    }

    const bodyText = await res.text().catch(() => '');
    const retryAfterHeader = res.headers.get('Retry-After');

    // 429 / 403-quota / 5xx — figure out if it's transient or daily-quota
    const isRateLimit = res.status === 429 || res.status === 403;
    const isServerError = res.status >= 500;

    if (isRateLimit || isServerError) {
      const quota = readQuotaInfo(res.status, bodyText, retryAfterHeader);

      // Daily quota or long Retry-After → don't burn our in-process retries
      // hammering it. Surface a typed error with the recovery hint so the
      // sync runner can set a longer cooldown on the whole connector.
      if (quota.isDaily) {
        const recoverSeconds = quota.retryAfterSeconds || 4 * 60 * 60; // default 4h
        throw new GoogleRateLimitError(
          `${label} daily quota exceeded (reason=${quota.reason ?? '?'})`,
          recoverSeconds,
          res.status,
          quota.reason,
          bodyText.slice(0, 240),
        );
      }

      if (attempt < maxRetries) {
        // Honor Retry-After if present (and short); else exponential backoff.
        const wait = quota.retryAfterSeconds > 0
          ? Math.min(quota.retryAfterSeconds * 1000, MAX_INLINE_RETRY_SECONDS * 1000)
          : backoffMs(attempt);
        console.warn(
          `[${label}] ${res.status} (reason=${quota.reason ?? '?'}, attempt ${attempt + 1}/${maxRetries}); waiting ${wait}ms`,
        );
        attempt += 1;
        await sleep(wait);
        continue;
      }

      // Out of in-process retries — surface as a rate-limit error so the
      // runner can decide whether to defer.
      throw new GoogleRateLimitError(
        `${label} ${res.status} ${res.statusText} after ${attempt + 1} attempts`,
        Math.max(quota.retryAfterSeconds, 60),
        res.status,
        quota.reason,
        bodyText.slice(0, 240),
      );
    }

    // Non-retryable error (400, 401, 404 etc.) — throw with details.
    throw Object.assign(
      new Error(`${label} API ${res.status} ${res.statusText}: ${bodyText.slice(0, 240)}`),
      { status: res.status, body: bodyText },
    );
  }
}
