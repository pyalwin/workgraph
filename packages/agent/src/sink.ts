import type { RuntimeEvent, AgentConfig } from './types.js';
import { apiFetch } from './client.js';

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH_SIZE = 50;
const CLOSE_DEADLINE_MS = 10_000;

// Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s.
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * EventSink — buffers RuntimeEvents and flushes them to the server in batches.
 *
 * Flush triggers:
 *   - Every 250 ms (interval timer)
 *   - Every 50 events (size threshold)
 *
 * On flush failure:
 *   - Retains the buffer and retries with exponential backoff (1s → 30s).
 *   - Never drops events.
 *   - Continues accepting emit() while retrying.
 *
 * close():
 *   - Cancels the interval timer.
 *   - Performs a final flush.
 *   - Returns a promise that resolves when the queue is empty or after 10s.
 */
export class EventSink {
  private buffer: RuntimeEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private backoffIndex = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly jobId: string,
    private readonly config: AgentConfig,
  ) {
    this.flushTimer = setInterval(() => {
      void this.maybeFlush();
    }, FLUSH_INTERVAL_MS);
  }

  emit(event: RuntimeEvent): void {
    this.buffer.push(event);
    echoEvent(this.jobId, event);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.maybeFlush();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }

    // Best-effort final flush with a 10s deadline.
    const deadline = Date.now() + CLOSE_DEADLINE_MS;
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this.flush();
      if (this.buffer.length > 0) {
        // Pause briefly before retry during close.
        await sleep(500);
      }
    }
  }

  private async maybeFlush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    // If a backoff timer is active, we're waiting to retry — don't flush now.
    if (this.backoffTimer !== null) return;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await apiFetch(
        `/api/agent/jobs/${this.jobId}/events`,
        { method: 'POST', body: { events: batch } },
        this.config,
      );
      // Success: reset backoff.
      this.backoffIndex = 0;
    } catch (err) {
      // Restore buffer — put batch back at the front so ordering is preserved.
      this.buffer.unshift(...batch);
      this.scheduleRetry(err);
    } finally {
      this.flushing = false;
    }
  }

  private scheduleRetry(err: unknown): void {
    if (this.backoffTimer !== null) return; // already scheduled
    const delay = BACKOFF_STEPS[Math.min(this.backoffIndex, BACKOFF_STEPS.length - 1)];
    this.backoffIndex++;
    console.error(
      `[EventSink] flush failed (job ${this.jobId}), retrying in ${delay}ms:`,
      err instanceof Error ? err.message : String(err),
    );
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.flush();
    }, delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function argsLabel(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return truncate(args, 240);
  try {
    return truncate(JSON.stringify(args), 240);
  } catch {
    return '';
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Track accumulated text-delta length per job so the operator gets a single
// progress line every ~2 KB instead of either a wall of per-keystroke noise
// or complete silence (which looks like the job died).
const textDeltaState = new Map<string, number>();
const DELTA_TICK_BYTES = 2000;

/**
 * Echo each event to stdout so the operator can watch a job progress in the
 * agent terminal. text-delta is summarised as periodic progress ticks;
 * tool-result output is collapsed to a short preview.
 */
function echoEvent(jobId: string, event: RuntimeEvent): void {
  const tag = `[job ${jobId.slice(0, 8)}]`;
  switch (event.type) {
    case 'log': {
      const stream = event.level === 'error' ? console.error : console.log;
      stream(`${tag} ${event.level === 'info' ? '·' : event.level.toUpperCase()} ${event.message}`);
      return;
    }
    case 'tool-call': {
      const args = argsLabel(event.args);
      console.log(`${tag} 🔧 ${event.tool}${args ? ` ${args}` : ''}`);
      return;
    }
    case 'tool-result': {
      const out = clean(event.output ?? '');
      console.log(`${tag} ↩  ${truncate(out, 240)}${event.truncated ? ' (truncated)' : ''}`);
      return;
    }
    case 'text-delta': {
      const prev = textDeltaState.get(jobId) ?? 0;
      const next = prev + event.text.length;
      textDeltaState.set(jobId, next);
      if (Math.floor(next / DELTA_TICK_BYTES) > Math.floor(prev / DELTA_TICK_BYTES)) {
        console.log(`${tag} ✍  +${(next / 1024).toFixed(1)}KB output`);
      }
      return;
    }
    case 'usage':
      console.log(
        `${tag} 📊 in=${event.input_tokens} out=${event.output_tokens}${
          event.cost_usd != null ? ` cost=$${event.cost_usd.toFixed(4)}` : ''
        }`,
      );
      return;
    case 'finish':
      textDeltaState.delete(jobId);
      if (event.reason === 'error') {
        console.error(`${tag} ✗ finish error: ${event.error ?? 'unknown'}`);
      } else {
        const chars = event.final_text?.length ?? 0;
        console.log(`${tag} ✓ finish ${event.reason}${chars ? ` (${chars}c text)` : ''}`);
      }
      return;
  }
}
