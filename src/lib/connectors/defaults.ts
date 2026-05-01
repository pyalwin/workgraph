/**
 * Single source of truth for "where do we start fetching from" across all
 * adapters. Override per-workspace by setting options.backfillFrom to either:
 *   - a date string ('2025-01-01'), or
 *   - the literal 'all' to disable the clamp entirely (sync full history).
 *
 * Adapters should call resolveSince() inside list.args(ctx) rather than
 * hardcoding their own dates.
 */

export const BACKFILL_DEFAULT_DATE = '2026-01-01';

export interface SinceResolution {
  /** YYYY-MM-DD when allTime=false; '' when allTime=true. */
  date: string;
  /** When true, the adapter should omit the date clause entirely. */
  allTime: boolean;
}

function isoToDate(iso: string): string {
  return iso.split('T')[0];
}

export function resolveSince(
  options: Record<string, unknown> | undefined,
  bucketLastSynced: string | undefined,
  fallback: string = BACKFILL_DEFAULT_DATE,
  /** CLI/orchestrator override — wins over bucketLastSynced when present. */
  explicitSince?: string | null | undefined,
): SinceResolution {
  // 0. Explicit `since` from the orchestrator (e.g. "Resync from scratch")
  //    always wins. 'all' / '*' disables the clause entirely; any other
  //    string is parsed as a date.
  if (typeof explicitSince === 'string' && explicitSince.trim()) {
    const s = explicitSince.trim().toLowerCase();
    if (s === 'all' || s === '*') return { date: '', allTime: true };
    return { date: isoToDate(explicitSince.trim()), allTime: false };
  }

  // 1. Per-bucket incremental — only when this bucket has history.
  if (bucketLastSynced) return { date: isoToDate(bucketLastSynced), allTime: false };

  // 2. Workspace override
  const backfillFrom = options?.backfillFrom;
  if (typeof backfillFrom === 'string') {
    const s = backfillFrom.trim().toLowerCase();
    if (s === 'all' || s === '*') return { date: '', allTime: true };
    if (backfillFrom.trim()) return { date: isoToDate(backfillFrom.trim()), allTime: false };
  }

  // 3. Default
  return { date: fallback, allTime: false };
}
