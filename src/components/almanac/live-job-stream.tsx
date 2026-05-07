'use client';

/**
 * LiveJobStream
 *
 * Opens an EventSource on GET /api/jobs/:jobId/events?since=<seq>.
 * Renders incoming RuntimeEvents compactly:
 *   - log    → grey text
 *   - tool-call  → "tool name + truncated args" in a small pill
 *   - tool-result → collapsed by default, expand on click
 *   - text-delta → not shown (rely on polling refetch for final markdown)
 *   - usage  → token/cost summary at the bottom
 *   - finish → closes stream, calls onFinish()
 *
 * Auto-scrolls to the latest event unless the user has scrolled up.
 * On reconnect, resumes from the last seen seq.
 */

import { useEffect, useRef, useState } from 'react';

type RuntimeEventType = 'log' | 'tool-call' | 'tool-result' | 'text-delta' | 'usage' | 'finish' | '_stream_end';

interface LogEvent {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}
interface ToolCallEvent {
  type: 'tool-call';
  tool: string;
  args: unknown;
  call_id: string;
}
interface ToolResultEvent {
  type: 'tool-result';
  call_id: string;
  output: string;
  truncated?: boolean;
}
interface TextDeltaEvent { type: 'text-delta'; text: string }
interface UsageEvent {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}
interface FinishEvent {
  type: 'finish';
  reason: 'stop' | 'error' | 'cancelled';
  final_text?: string;
  error?: string;
}
interface StreamEndEvent { type: '_stream_end'; status: string }

type RuntimeEvent =
  | LogEvent
  | ToolCallEvent
  | ToolResultEvent
  | TextDeltaEvent
  | UsageEvent
  | FinishEvent
  | StreamEndEvent;

interface EnrichedEvent {
  seq: number;
  event: RuntimeEvent;
}

interface LiveJobStreamProps {
  jobId: string;
  /** Called when the stream finishes (finish event or _stream_end). */
  onFinish?: () => void;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function argsLabel(args: unknown): string {
  if (!args) return '';
  if (typeof args === 'string') return truncate(args, 60);
  try {
    const str = JSON.stringify(args);
    return truncate(str, 60);
  } catch {
    return '';
  }
}

function toolIcon(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('file')) return '📖';
  if (lower.includes('write')) return '✏️';
  if (lower.includes('grep') || lower.includes('search') || lower.includes('find')) return '🔍';
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('run')) return '⚙️';
  if (lower.includes('list')) return '📋';
  return '🔧';
}

function ToolCallRow({ event }: { event: ToolCallEvent }) {
  const label = argsLabel(event.args);
  return (
    <div style={rowStyles.toolCall}>
      <span style={rowStyles.toolIcon}>{toolIcon(event.tool)}</span>
      <span style={rowStyles.toolName}>{event.tool}</span>
      {label && (
        <span style={rowStyles.toolArgs}>{label}</span>
      )}
    </div>
  );
}

function ToolResultRow({ event }: { event: ToolResultEvent }) {
  const [expanded, setExpanded] = useState(false);
  const preview = truncate(event.output ?? '', 120);
  return (
    <div style={rowStyles.toolResult}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={rowStyles.toolResultToggle}
      >
        {expanded ? '▾' : '▸'} result{event.truncated ? ' (truncated)' : ''}
      </button>
      {expanded && (
        <pre style={rowStyles.toolResultBody}>{event.output}</pre>
      )}
      {!expanded && <span style={rowStyles.toolResultPreview}>{preview}</span>}
    </div>
  );
}

export function LiveJobStream({ jobId, onFinish }: LiveJobStreamProps) {
  const [events, setEvents] = useState<EnrichedEvent[]>([]);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const lastSeqRef = useRef<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  // doneRef mirrors `done` for closure-safe reads inside reconnect timers.
  const doneRef = useRef(false);

  useEffect(() => {
    doneRef.current = false;
    setDone(false);
    setEvents([]);
    setErrorMsg(null);
    lastSeqRef.current = -1;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (doneRef.current) return;
      esRef.current?.close();

      const since = lastSeqRef.current;
      const url = `/api/jobs/${jobId}/events?since=${since}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        attempt = 0;
      };

      es.onmessage = (e: MessageEvent) => {
        let parsed: { seq?: number; type: RuntimeEventType; payload?: RuntimeEvent } & RuntimeEvent;
        try {
          parsed = JSON.parse(e.data as string) as typeof parsed;
        } catch {
          return;
        }

        if (parsed.type === '_stream_end') {
          doneRef.current = true;
          setDone(true);
          es.close();
          onFinish?.();
          return;
        }

        const seq = parsed.seq ?? 0;
        const payload = (parsed as { payload?: RuntimeEvent }).payload ?? (parsed as RuntimeEvent);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);

        if (payload.type === 'finish') {
          setEvents((prev) => [...prev, { seq, event: payload }]);
          doneRef.current = true;
          setDone(true);
          es.close();
          onFinish?.();
          return;
        }

        if (payload.type === 'text-delta') return;

        setEvents((prev) => [...prev, { seq, event: payload }]);
      };

      es.onerror = () => {
        es.close();
        if (doneRef.current) return;
        // Exponential backoff with cap — avoids the 2s-flat reconnect loop
        // when the job_id doesn't exist or the user lacks access.
        attempt += 1;
        if (attempt > 6) {
          setErrorMsg('Lost connection to job stream — refresh to retry.');
          return;
        }
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      doneRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      esRef.current?.close();
    };
  }, [jobId, onFinish]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledRef.current = !nearBottom;
  };

  return (
    <div style={containerStyles.wrap}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={containerStyles.scroll}
      >
        {events.length === 0 && !done && (
          <div style={containerStyles.waiting}>Waiting for events…</div>
        )}

        {events.map(({ seq, event }) => {
          if (event.type === 'log') {
            return (
              <div key={seq} style={{ ...rowStyles.log, ...(event.level === 'error' ? rowStyles.logError : event.level === 'warn' ? rowStyles.logWarn : {}) }}>
                {event.message}
              </div>
            );
          }
          if (event.type === 'tool-call') {
            return <ToolCallRow key={seq} event={event} />;
          }
          if (event.type === 'tool-result') {
            return <ToolResultRow key={seq} event={event} />;
          }
          if (event.type === 'usage') {
            return (
              <div key={seq} style={rowStyles.usage}>
                {event.input_tokens + event.output_tokens} tokens
                {event.cost_usd != null ? ` · $${event.cost_usd.toFixed(4)}` : ''}
              </div>
            );
          }
          if (event.type === 'finish') {
            return (
              <div key={seq} style={event.reason === 'error' ? rowStyles.finishError : rowStyles.finishOk}>
                {event.reason === 'error' ? `Error: ${event.error ?? 'unknown'}` : `Done (${event.reason})`}
              </div>
            );
          }
          return null;
        })}

        {errorMsg && (
          <div style={rowStyles.logError}>{errorMsg}</div>
        )}

        {done && events.length > 0 && (
          <div style={containerStyles.doneMark}>— stream closed —</div>
        )}
      </div>
    </div>
  );
}

const containerStyles = {
  wrap: {
    borderRadius: 8,
    border: '1px solid var(--rule)',
    background: 'var(--surface)',
    overflow: 'hidden',
    fontSize: 12,
    fontFamily: 'var(--mono)',
  } as React.CSSProperties,

  scroll: {
    maxHeight: 300,
    overflowY: 'auto' as const,
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  } as React.CSSProperties,

  waiting: {
    color: 'var(--ink-5)',
    fontStyle: 'italic',
    padding: '4px 0',
  } as React.CSSProperties,

  doneMark: {
    color: 'var(--ink-5)',
    textAlign: 'center' as const,
    paddingTop: 6,
    borderTop: '1px solid var(--rule)',
    marginTop: 6,
  } as React.CSSProperties,
} as const;

const rowStyles = {
  log: {
    color: 'var(--ink-4)',
    padding: '1px 0',
    lineHeight: 1.4,
    wordBreak: 'break-all' as const,
  } as React.CSSProperties,

  logWarn: {
    color: 'var(--amber)',
  } as React.CSSProperties,

  logError: {
    color: 'var(--red)',
  } as React.CSSProperties,

  toolCall: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 0',
    color: 'var(--ink-2)',
  } as React.CSSProperties,

  toolIcon: {
    fontSize: 13,
  } as React.CSSProperties,

  toolName: {
    fontWeight: 600,
    color: 'var(--ink)',
  } as React.CSSProperties,

  toolArgs: {
    color: 'var(--ink-4)',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: 400,
  } as React.CSSProperties,

  toolResult: {
    padding: '2px 0',
  } as React.CSSProperties,

  toolResultToggle: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    color: 'var(--ink-4)',
    padding: 0,
    marginRight: 6,
  } as React.CSSProperties,

  toolResultPreview: {
    color: 'var(--ink-5)',
  } as React.CSSProperties,

  toolResultBody: {
    marginTop: 4,
    padding: 8,
    background: 'var(--bone)',
    borderRadius: 4,
    color: 'var(--ink-3)',
    whiteSpace: 'pre-wrap' as const,
    fontSize: 11,
    maxHeight: 200,
    overflowY: 'auto' as const,
  } as React.CSSProperties,

  usage: {
    color: 'var(--ink-5)',
    paddingTop: 4,
    borderTop: '1px solid var(--rule)',
    marginTop: 4,
  } as React.CSSProperties,

  finishOk: {
    color: 'var(--green)',
    fontWeight: 600,
    paddingTop: 4,
  } as React.CSSProperties,

  finishError: {
    color: 'var(--red)',
    fontWeight: 600,
    paddingTop: 4,
  } as React.CSSProperties,
} as const;
