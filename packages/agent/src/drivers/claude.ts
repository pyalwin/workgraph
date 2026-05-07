import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeEvent } from '../types.js';

const STDERR_THROTTLE_WINDOW_MS = 1000;
const STDERR_MAX_PER_WINDOW = 100;
const PARSE_FAILURE_REPORT_INTERVAL = 100;

export interface StreamClaudeOpts {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  signal?: AbortSignal;
  resumeSessionId?: string;
}

/**
 * ClaudeStream — the return type of streamClaude.
 * It is an AsyncIterable<RuntimeEvent> and also exposes the captured
 * session_id once the system.init line has been parsed.
 *
 * The caller (job dispatcher) should save sessionId after iteration
 * completes to enable future resume.
 *
 * TODO(dispatcher): Persist sessionId to ~/.workgraph/sessions/<job_id>.json
 * after the job completes. The driver doesn't know the job_id so the
 * dispatcher must do this.
 */
export interface ClaudeStream extends AsyncIterable<RuntimeEvent> {
  /** Populated once the system.init event is parsed (after first next() call). */
  sessionId: string | undefined;
}

/**
 * streamClaude — spawns `claude` CLI and translates stream-json output into
 * RuntimeEvents.
 *
 * PURE: does not post to the network. Caller pipes events into an EventSink.
 *
 * On AbortSignal: sends SIGTERM to the child, then SIGKILL after 5s if still alive.
 */
export function streamClaude(opts: StreamClaudeOpts): ClaudeStream {
  // Mutable session id that gets populated as lines arrive.
  let capturedSessionId: string | undefined;

  const iterable: AsyncIterable<RuntimeEvent> = generateEvents(opts, (sid) => {
    capturedSessionId = sid;
  });

  // Wrap with the sessionId property.
  const stream: ClaudeStream = {
    [Symbol.asyncIterator]() {
      return iterable[Symbol.asyncIterator]();
    },
    get sessionId() {
      return capturedSessionId;
    },
  };

  return stream;
}

async function* generateEvents(
  opts: StreamClaudeOpts,
  onSessionId: (id: string) => void,
): AsyncGenerator<RuntimeEvent> {
  const args = buildArgs(opts);

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  function abort() {
    if (aborted) return;
    aborted = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      abort();
    } else {
      opts.signal.addEventListener('abort', abort, { once: true });
    }
  }

  // ── Event queue ───────────────────────────────────────────────────────────
  const queue: RuntimeEvent[] = [];
  let producerDone = false;
  let wakeUp: (() => void) | null = null;

  function enqueue(ev: RuntimeEvent): void {
    queue.push(ev);
    if (wakeUp) {
      const r = wakeUp;
      wakeUp = null;
      r();
    }
  }

  function markDone(): void {
    producerDone = true;
    if (wakeUp) {
      const r = wakeUp;
      wakeUp = null;
      r();
    }
  }

  // ── Stderr (throttled) ────────────────────────────────────────────────────
  let stderrCount = 0;
  let stderrWindowStart = Date.now();

  const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  stderrRl.on('line', (line: string) => {
    const now = Date.now();
    if (now - stderrWindowStart > STDERR_THROTTLE_WINDOW_MS) {
      stderrCount = 0;
      stderrWindowStart = now;
    }
    if (stderrCount < STDERR_MAX_PER_WINDOW) {
      stderrCount++;
      enqueue({ type: 'log', level: 'warn', message: `[claude stderr] ${line}` });
    } else if (stderrCount === STDERR_MAX_PER_WINDOW) {
      stderrCount++;
      enqueue({
        type: 'log',
        level: 'warn',
        message: `[claude stderr] throttled — more than ${STDERR_MAX_PER_WINDOW} lines/s`,
      });
    }
    // Further lines dropped while throttled.
  });

  // ── Stdout / JSON parsing ─────────────────────────────────────────────────
  let parseFailures = 0;
  let parseFailureBatch = 0;
  let sawFinish = false;

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  stdoutRl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseFailures++;
      parseFailureBatch++;
      if (parseFailureBatch >= PARSE_FAILURE_REPORT_INTERVAL) {
        enqueue({
          type: 'log',
          level: 'warn',
          message: `[claude driver] ${parseFailureBatch} unparseable stdout lines (total ${parseFailures})`,
        });
        parseFailureBatch = 0;
      }
      return;
    }

    const events = translateEvent(parsed, onSessionId);
    for (const ev of events) {
      if (ev.type === 'finish') sawFinish = true;
      enqueue(ev);
    }
  });

  stdoutRl.on('close', () => {
    // Flush any remaining parse failure count.
    if (parseFailureBatch > 0) {
      enqueue({
        type: 'log',
        level: 'warn',
        message: `[claude driver] ${parseFailureBatch} unparseable stdout lines (total ${parseFailures})`,
      });
    }
  });

  // ── Process exit ──────────────────────────────────────────────────────────
  child.on('close', (code, signal) => {
    if (killTimer !== null) clearTimeout(killTimer);
    if (opts.signal) opts.signal.removeEventListener('abort', abort);

    if (!sawFinish) {
      // No 'result' line arrived — synthesise a finish event.
      if (aborted) {
        enqueue({ type: 'finish', reason: 'cancelled' });
      } else if (code !== 0) {
        enqueue({
          type: 'finish',
          reason: 'error',
          error: `claude exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
        });
      }
      // code === 0 but no result line: shouldn't happen with stream-json, but
      // we don't synthesise a stop finish — the 'result' line should have it.
    }

    markDone();
  });

  // ── Yield loop ────────────────────────────────────────────────────────────
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (producerDone) break;
    await new Promise<void>((resolve) => {
      // Guard: something may have arrived or done may have been set between
      // the queue check and registering the resolver.
      if (queue.length > 0 || producerDone) {
        resolve();
        return;
      }
      wakeUp = resolve;
    });
  }

  // Drain any events that arrived in the final tick.
  while (queue.length > 0) {
    yield queue.shift()!;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Arg builder
// ────────────────────────────────────────────────────────────────────────────

function buildArgs(opts: StreamClaudeOpts): string[] {
  const args: string[] = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(','));
  }

  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push('--disallowed-tools', opts.disallowedTools.join(','));
  }

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  return args;
}

// ────────────────────────────────────────────────────────────────────────────
// Event translation — pure function, no I/O
// ────────────────────────────────────────────────────────────────────────────

/**
 * Translate a single parsed Claude stream-json object into zero or more RuntimeEvents.
 * The onSessionId callback is called when a session_id is encountered.
 */
export function translateEvent(
  raw: unknown,
  onSessionId?: (id: string) => void,
): RuntimeEvent[] {
  if (!isRecord(raw)) return [];

  const type = raw['type'];

  // ── system.init ───────────────────────────────────────────────────────────
  if (type === 'system' && raw['subtype'] === 'init') {
    const sessionId = String(raw['session_id'] ?? '');
    if (onSessionId) onSessionId(sessionId);
    return [
      {
        type: 'log',
        level: 'info',
        message: `[claude session_id] ${sessionId}`,
      },
    ];
  }

  // ── stream_event (content block deltas) ──────────────────────────────────
  if (type === 'stream_event') {
    const event = raw['event'];
    if (!isRecord(event)) return [];

    if (
      event['type'] === 'content_block_delta' &&
      isRecord(event['delta']) &&
      event['delta']['type'] === 'text_delta' &&
      typeof event['delta']['text'] === 'string'
    ) {
      return [{ type: 'text-delta', text: event['delta']['text'] as string }];
    }

    return [];
  }

  // ── assistant message (tool_use content blocks) ───────────────────────────
  if (type === 'assistant') {
    const message = raw['message'];
    if (!isRecord(message)) return [];
    const content = message['content'];
    if (!Array.isArray(content)) return [];

    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        events.push({
          type: 'tool-call',
          tool: String(block['name'] ?? ''),
          args: block['input'] ?? {},
          call_id: String(block['id'] ?? ''),
        });
      }
    }
    return events;
  }

  // ── user message (tool_result content blocks) ─────────────────────────────
  if (type === 'user') {
    const message = raw['message'];
    if (!isRecord(message)) return [];
    const content = message['content'];
    if (!Array.isArray(content)) return [];

    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'tool_result') {
        events.push({
          type: 'tool-result',
          call_id: String(block['tool_use_id'] ?? ''),
          output: extractToolResultOutput(block['content']),
        });
      }
    }
    return events;
  }

  // ── result (terminal Claude event) ────────────────────────────────────────
  if (type === 'result') {
    const events: RuntimeEvent[] = [];

    const usage = raw['usage'];
    if (isRecord(usage)) {
      const costUsd = typeof usage['cost_usd'] === 'number' ? usage['cost_usd'] : undefined;
      events.push({
        type: 'usage',
        input_tokens: Number(usage['input_tokens'] ?? 0),
        output_tokens: Number(usage['output_tokens'] ?? 0),
        ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
      });
    }

    const subtype = raw['subtype'];
    let reason: 'stop' | 'error' | 'cancelled';
    if (subtype === 'success') {
      reason = 'stop';
    } else if (subtype === 'error_during_execution' || subtype === 'error') {
      reason = 'error';
    } else if (subtype === 'cancelled') {
      reason = 'cancelled';
    } else {
      reason = 'stop';
    }

    const finalText = typeof raw['result'] === 'string' ? raw['result'] : undefined;
    const errorMsg =
      reason === 'error' && typeof raw['error'] === 'string' ? raw['error'] : undefined;

    events.push({
      type: 'finish',
      reason,
      ...(finalText !== undefined ? { final_text: finalText } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
    });

    return events;
  }

  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function extractToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
          ? (block['text'] as string)
          : '',
      )
      .join('');
  }
  return String(content ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
