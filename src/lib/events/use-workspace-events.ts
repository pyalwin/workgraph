'use client';

import { useEffect, useRef } from 'react';

/**
 * Subscribe to /api/events for the current workspace.
 *
 * - Opens one EventSource per page-mount. Reconnects with exponential
 *   backoff on error.
 * - Tracks `since` across reconnects so the client doesn't miss events
 *   while it was briefly disconnected (up to whatever the SSE endpoint
 *   keeps in workspace_events).
 * - `onEvent` is called for every event whose kind matches `topics`.
 *   `topics` is also sent server-side as a query param so the SSE
 *   handler can skip irrelevant kinds before writing them out.
 *
 * Stable callback contract: `onEvent` is read from a ref so callers
 * don't need to memoize it. The effect only re-runs when `topics`
 * actually changes (compared by sorted string).
 */
export function useWorkspaceEvents(
  topics: readonly string[],
  onEvent: (evt: WorkspaceEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Stable key so the effect doesn't churn when callers pass a fresh array
  // literal on every render.
  const topicsKey = [...topics].sort().join(',');

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cursor = 0;

    const connect = () => {
      if (cancelled) return;
      es?.close();
      const qs = new URLSearchParams({ since: String(cursor) });
      if (topicsKey) qs.set('topics', topicsKey);
      es = new EventSource(`/api/events?${qs.toString()}`);

      es.onopen = () => {
        attempt = 0;
      };

      es.onmessage = (e: MessageEvent) => {
        let parsed: WorkspaceEvent | null = null;
        try {
          parsed = JSON.parse(e.data as string) as WorkspaceEvent;
        } catch {
          return;
        }
        if (!parsed || typeof parsed.seq !== 'number') return;
        cursor = Math.max(cursor, parsed.seq);
        onEventRef.current(parsed);
      };

      es.onerror = () => {
        // EventSource will normally auto-reconnect itself, but it doesn't
        // back off — a server that consistently 5xx's would get hammered.
        // Close and reconnect manually with exponential backoff.
        es?.close();
        if (cancelled) return;
        attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 6), 30_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [topicsKey]);
}

export interface WorkspaceEvent {
  seq: number;
  kind: string;
  payload: unknown;
  created_at: string;
}
