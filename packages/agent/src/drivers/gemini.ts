/**
 * Gemini CLI driver for the agent.
 *
 * Spawns `gemini -p <prompt> -o stream-json` and parses incremental events.
 * Gemini's stream-json varies by version: {type:'text', text} and
 * {type:'delta', text} both carry incremental content; {type:'complete'}
 * or {type:'done'} terminates.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeEvent } from '../types.js';

export interface StreamGeminiOpts {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** When true (workflow summarization), runs in plan mode (read-only). */
  disableTools?: boolean;
}

export type GeminiStream = AsyncIterable<RuntimeEvent>;

export function streamGemini(opts: StreamGeminiOpts): GeminiStream {
  return generate(opts);
}

async function* generate(opts: StreamGeminiOpts): AsyncGenerator<RuntimeEvent> {
  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  const args = ['-p', fullPrompt, '-o', 'stream-json'];
  if (opts.model) args.push('-m', opts.model);
  if (opts.disableTools) {
    args.push('--approval-mode', 'plan'); // read-only
  } else {
    args.push('--yolo'); // auto-approve tool actions
  }

  const child = spawn('gemini', args, {
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

  const queue: RuntimeEvent[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;
  let exitCode: number | null = null;
  const enqueue = (e: RuntimeEvent) => {
    queue.push(e);
    if (waiter) { const w = waiter; waiter = null; w(); }
  };

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });

  stdoutRl.on('line', (line: string) => {
    let evt: Record<string, unknown> | null = null;
    try { evt = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (!evt) return;
    const t = evt.type as string | undefined;
    if ((t === 'text' || t === 'content' || t === 'delta') && typeof evt.text === 'string') {
      enqueue({ type: 'text-delta', text: evt.text });
    } else if ((t === 'complete' || t === 'done' || t === 'finish') && finished === false) {
      enqueue({ type: 'log', level: 'info', message: '[gemini] complete' });
    } else if (t === 'error' && typeof evt.message === 'string') {
      enqueue({ type: 'log', level: 'error', message: `[gemini] ${evt.message}` });
    }
  });

  let stderrCount = 0;
  stderrRl.on('line', (line: string) => {
    if (stderrCount++ < 100) enqueue({ type: 'log', level: 'warn', message: `[gemini stderr] ${line}` });
  });

  child.on('close', (code) => { exitCode = code; finished = true; if (waiter) { const w = waiter; waiter = null; w(); } });
  child.on('error', (err) => { enqueue({ type: 'log', level: 'error', message: `[gemini] spawn error: ${err.message}` }); finished = true; if (waiter) { const w = waiter; waiter = null; w(); } });

  try {
    while (true) {
      while (queue.length === 0 && !finished) {
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
    }
    yield { type: 'finish', reason: exitCode === 0 ? 'stop' : 'error' } as RuntimeEvent;
  } finally {
    opts.signal?.removeEventListener('abort', abortHandler);
    if (!child.killed) child.kill('SIGTERM');
  }
}
