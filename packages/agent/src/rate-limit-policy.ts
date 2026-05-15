/**
 * Per-provider rate-limit policy.
 *
 * Each provider that the agent talks to (Anthropic via Claude CLI, Google
 * APIs via direct REST, etc.) has its own quota recovery semantics. This
 * module is the single place those policies live so handlers don't have
 * to encode "1h vs 24h" inline.
 *
 *   short_retries   — how many in-process retries the agent does (seconds
 *                     backoff, 2s/4s) before giving up and deferring.
 *   defer_seconds   — how long the agent asks the server to wait before
 *                     re-queueing. Server clamps to [60s, 24h].
 *
 * The patterns array is what the agent scans in stderr / response body
 * to detect rate-limit/quota errors specific to that provider.
 */

export interface RateLimitPolicy {
  /** Human label, surfaced in logs. */
  label: string;
  /** In-process retry count with seconds backoff (2s, 4s, ...). */
  short_retries: number;
  /** Defer interval to send to the server when short retries are exhausted. */
  defer_seconds: number;
  /** Patterns indicating this provider is rate-limited. */
  patterns: RegExp[];
}

const COMMON_RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /quota[\s_-]?exceeded/i,
  /too many requests/i,
];

export const ANTHROPIC_POLICY: RateLimitPolicy = {
  label: 'Anthropic (Claude)',
  short_retries: 2,
  // Anthropic's normal 429 recovery is minutes, but daily/monthly token
  // caps for Claude Code subscriptions reset on a longer cadence — and
  // we'd rather defer for an hour and try again than spam retries.
  defer_seconds: 60 * 60, // 1 hour
  patterns: [
    ...COMMON_RATE_LIMIT_PATTERNS,
    /credit[\s_-]?balance/i,
    /usage[\s_-]?limit/i,
    /overloaded/i,
  ],
};

export const GOOGLE_API_POLICY: RateLimitPolicy = {
  label: 'Google API',
  short_retries: 2,
  // Google daily quotas reset at midnight Pacific. 4h gives several
  // attempts per day without burning the whole quota again on retry.
  defer_seconds: 4 * 60 * 60, // 4 hours
  patterns: [
    ...COMMON_RATE_LIMIT_PATTERNS,
    /quotaExceeded/i,
    /userRateLimitExceeded/i,
    /dailyLimitExceeded/i,
  ],
};

export const DEFAULT_POLICY: RateLimitPolicy = {
  label: 'Default',
  short_retries: 2,
  defer_seconds: 60 * 60, // 1 hour
  patterns: COMMON_RATE_LIMIT_PATTERNS,
};

export function detectRateLimit(text: string, policy: RateLimitPolicy): boolean {
  if (!text) return false;
  return policy.patterns.some((p) => p.test(text));
}

/**
 * Compute the next short-retry backoff (in ms). Exponential 2s, 4s, 8s
 * but capped at 30s so the agent doesn't hold the worker for too long
 * before deferring.
 */
export function shortBackoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}
