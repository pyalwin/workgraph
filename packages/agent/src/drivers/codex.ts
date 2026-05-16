/**
 * Codex CLI driver for the agent.
 *
 * Same shape as the claude driver: spawn `codex exec --json <prompt>`,
 * parse JSONL output, yield RuntimeEvents (text-delta + finish + log).
 *
 * Codex emits both delta events (incremental tokens) and a final
 * agent_message containing the full text. To avoid double-output we
 * suppress the final message if any deltas were already seen.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeEvent } from '../types.js';

export interface StreamCodexOpts {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Workflow summarization runs in read-only sandbox; agentic uses workspace-write. */
  disableTools?: boolean;
}

export type CodexStream = AsyncIterable<RuntimeEvent>;

export function streamCodex(opts: StreamCodexOpts): CodexStream {
  return generate(opts);
}

async function* generate(opts: StreamCodexOpts): AsyncGenerator<RuntimeEvent> {
  const args = ['exec', '--json'];
  if (opts.model) args.push('-c', `model="${opts.model}"`);
  if (opts.disableTools) args.push('--sandbox', 'read-only');

  // Codex has no first-class --system flag — prepend with a separator.
  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  args.push(fullPrompt);

  const child = spawn('codex', args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const abortHandler = () => {
    if (!child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }
  };
  opts.signal?.addEventListener('abort', abortHandler);

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });

  // Collect lines via a producer queue so we can multiplex stdout+stderr.
  const queue: RuntimeEvent[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;
  let exitCode: number | null = null;
  const enqueue = (e: RuntimeEvent) => {
    queue.push(e);
    if (waiter) { const w = waiter; waiter = null; w(); }
  };

  stdoutRl.on('line', (line: string) => {
    let evt: Record<string, unknown> | null = null;
    try { evt = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (!evt) return;
    // New envelope: { id, msg: { type, ... } }; older: flat.
    const msg = (evt.msg ?? evt) as Record<string, unknown>;
    const t = (msg.type ?? evt.type) as string | undefined;
    if (t === 'agent_message_delta' && typeof msg.delta === 'string') {
      enqueue({ type: 'text-delta', text: msg.delta });
    } else if (t === 'agent_message' && typeof msg.message === 'string') {
      // Final message — suppressed below if any delta already emitted.
      enqueue({ type: 'text-delta', text: msg.message });
    } else if (t === 'error' && typeof msg.message === 'string') {
      enqueue({ type: 'log', level: 'error', message: `[codex] ${msg.message}` });
    }
  });

  let stderrCount = 0;
  stderrRl.on('line', (line: string) => {
    if (stderrCount++ < 100) enqueue({ type: 'log', level: 'warn', message: `[codex stderr] ${line}` });
  });

  child.on('close', (code) => { exitCode = code; finished = true; if (waiter) { const w = waiter; waiter = null; w(); } });
  child.on('error', (err) => { enqueue({ type: 'log', level: 'error', message: `[codex] spawn error: ${err.message}` }); finished = true; if (waiter) { const w = waiter; waiter = null; w(); } });

  try {
    let streamedAnyDelta = false;
    while (true) {
      while (queue.length === 0 && !finished) {
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
      if (queue.length > 0) {
        const evt = queue.shift()!;
        if (evt.type === 'text-delta') streamedAnyDelta = true;
        yield evt;
        continue;
      }
      if (finished) break;
    }
    yield {
      type: 'finish',
      reason: exitCode === 0 ? 'stop' : 'error',
    } as RuntimeEvent;
  } finally {
    opts.signal?.removeEventListener('abort', abortHandler);
    if (!child.killed) child.kill('SIGTERM');
  }
}
