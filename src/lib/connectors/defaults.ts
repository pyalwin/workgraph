/**
 * Single source of truth for "what time window to fetch" across all
 * adapters. Override per-connector via the saved options:
 *   - options.backfillFrom: ISO date ('2025-01-01') | 'all' | omitted
 *   - options.backfillUntil: ISO date | omitted (defaults to now)
 *   - options.backfillDays: integer (e.g. 30) for a rolling window
 *
 * When nothing is set, the default is a rolling 90-day window from today.
 * Adapters should call resolveSince() inside list.args(ctx) rather than
 * hardcoding their own dates.
 */

export const DEFAULT_BACKFILL_DAYS = 90;

/**
 * Legacy export kept for callers using a fixed-date fallback. Computed
 * at module-load time as `today - DEFAULT_BACKFILL_DAYS`. Prefer
 * resolveSince() (which recomputes per-call) over this constant.
 */
export const BACKFILL_DEFAULT_DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - DEFAULT_BACKFILL_DAYS);
  return d.toISOString().split('T')[0];
})();

export interface SinceResolution {
  /** YYYY-MM-DD when allTime=false; '' when allTime=true. */
  date: string;
  /** Optional end of window (YYYY-MM-DD). Empty when unbounded / now. */
  until: string;
  /** When true, the adapter should omit the date clause entirely. */
  allTime: boolean;
}

function isoToDate(iso: string): string {
  return iso.split('T')[0];
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

export function resolveSince(
  options: Record<string, unknown> | undefined,
  bucketLastSynced: string | undefined,
  fallback?: string | number,
  /** CLI/orchestrator override — wins over bucketLastSynced when present. */
  explicitSince?: string | null | undefined,
): SinceResolution {
  const until = readUntil(options);

  // 0. Explicit `since` from the orchestrator (e.g. "Resync from scratch")
  //    always wins. 'all' / '*' disables the clause entirely; any other
  //    string is parsed as a date.
  if (typeof explicitSince === 'string' && explicitSince.trim()) {
    const s = explicitSince.trim().toLowerCase();
    if (s === 'all' || s === '*') return { date: '', until, allTime: true };
    return { date: isoToDate(explicitSince.trim()), until, allTime: false };
  }

  // 1. Per-bucket incremental — only when this bucket has history.
  if (bucketLastSynced) return { date: isoToDate(bucketLastSynced), until, allTime: false };

  // 2. Workspace override (relative window first, then absolute)
  const backfillDays = options?.backfillDays;
  if (typeof backfillDays === 'number' && backfillDays > 0) {
    return { date: daysAgoIso(backfillDays), until, allTime: false };
  }
  const backfillFrom = options?.backfillFrom;
  if (typeof backfillFrom === 'string') {
    const s = backfillFrom.trim().toLowerCase();
    if (s === 'all' || s === '*') return { date: '', until, allTime: true };
    if (backfillFrom.trim()) return { date: isoToDate(backfillFrom.trim()), until, allTime: false };
  }

  // 3. Caller-provided fallback (string ISO date or number of days).
  if (typeof fallback === 'number' && fallback > 0) {
    return { date: daysAgoIso(fallback), until, allTime: false };
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return { date: isoToDate(fallback), until, allTime: false };
  }

  // 4. Global default — rolling 90 days from today.
  return { date: daysAgoIso(DEFAULT_BACKFILL_DAYS), until, allTime: false };
}

function readUntil(options: Record<string, unknown> | undefined): string {
  const v = options?.backfillUntil;
  if (typeof v === 'string' && v.trim()) return isoToDate(v.trim());
  return '';
}
