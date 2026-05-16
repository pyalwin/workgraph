import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { readConfig } from '../config.js';
import { apiFetch } from '../client.js';
import { ApiError } from '../client.js';
import { EventSink } from '../sink.js';
import { dispatch } from '../dispatcher.js';
import { registerAllHandlers } from '../handlers/index.js';
import { AGENT_VERSION } from '../version.js';
import type { Job, AgentConfig } from '../types.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_WAIT_MS = 25_000;
// Backoff schedule for transient errors (network blips, 5xx).
// Exponential up to a cap, with jitter so multiple agents don't sync up.
const TRANSIENT_BACKOFF_MIN_MS = 5_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;
// 401/403 means the token is wrong or revoked. No amount of retrying fixes
// that — back off hard, and exit after enough consecutive failures so we
// don't burn server resources forever (the bug that prompted these knobs:
// a stale launchd-managed agent kept 401-ing every 5s at 12 req/min).
const AUTH_BACKOFF_MS = 60_000;
const AUTH_FAIL_LIMIT = 5;

export async function runCommand(): Promise<void> {
  // Register all custom job handlers before the poll loop starts.
  registerAllHandlers();

  const config = await readConfig();
  if (!config) {
    console.error('Not paired. Run `workgraph login` first.');
    process.exit(1);
  }

  console.log(`Starting Workgraph agent (${config.agent_id}) → ${config.base_url}`);

  let running = true;

  // Graceful shutdown: set flag and let in-flight work drain naturally.
  process.on('SIGINT', () => {
    if (running) {
      console.log('\nShutting down (waiting for in-flight work to drain)...');
      running = false;
    }
  });
  process.on('SIGTERM', () => {
    running = false;
  });

  // Both loops share a single "auth failed" gate. Either loop tripping the
  // limit flips `running` to false so the whole agent exits, surfacing the
  // problem instead of hammering the server forever.
  const setStopped = (reason: string) => {
    if (!running) return;
    console.error(`Agent stopping: ${reason}`);
    running = false;
  };

  await Promise.all([
    heartbeatLoop(config, () => running, setStopped),
    pollLoop(config, () => running, setStopped),
  ]);

  console.log('Agent stopped.');
}

// ────────────────────────────────────────────────────────────────
// Heartbeat loop — fires every 30 s while running.
// ────────────────────────────────────────────────────────────────

async function heartbeatLoop(
  config: AgentConfig,
  isRunning: () => boolean,
  stop: (reason: string) => void,
): Promise<void> {
  let authFailures = 0;
  // Send an initial heartbeat immediately.
  const initial = await sendHeartbeat(config);
  if (initial === 'auth') authFailures++;
  if (initial === 'auth' && authFailures >= AUTH_FAIL_LIMIT) {
    stop(`heartbeat hit ${AUTH_FAIL_LIMIT} consecutive 401s — token likely revoked, re-run \`workgraph login\``);
    return;
  }

  while (isRunning()) {
    const interval = authFailures > 0 ? AUTH_BACKOFF_MS : HEARTBEAT_INTERVAL_MS;
    await sleep(interval);
    if (!isRunning()) break;
    const outcome = await sendHeartbeat(config);
    if (outcome === 'auth') {
      authFailures++;
      if (authFailures >= AUTH_FAIL_LIMIT) {
        stop(`heartbeat hit ${AUTH_FAIL_LIMIT} consecutive 401s — token likely revoked, re-run \`workgraph login\``);
        return;
      }
    } else {
      authFailures = 0;
    }
  }
}

async function sendHeartbeat(config: AgentConfig): Promise<'ok' | 'auth' | 'other'> {
  // Detect all three CLIs in parallel — each times out independently at 2s.
  const [claudeCli, codexCli, geminiCli] = await Promise.all([
    detectCli('claude'),
    detectCli('codex'),
    detectCli('gemini'),
  ]);
  const payload = {
    hostname: hostname(),
    platform: platform(),
    version: AGENT_VERSION,
    claude_cli: claudeCli,
    codex_cli: codexCli,
    gemini_cli: geminiCli,
  };
  try {
    await apiFetch('/api/agent/heartbeat', { method: 'POST', body: payload }, config);
    return 'ok';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[heartbeat] error:', msg);
    return err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'auth' : 'other';
  }
}

// ────────────────────────────────────────────────────────────────
// Poll loop — long-polls for the next job.
// ────────────────────────────────────────────────────────────────

async function pollLoop(
  config: AgentConfig,
  isRunning: () => boolean,
  stop: (reason: string) => void,
): Promise<void> {
  let authFailures = 0;
  let transientBackoffMs = TRANSIENT_BACKOFF_MIN_MS;

  while (isRunning()) {
    try {
      const result = (await apiFetch(
        '/api/agent/jobs/poll',
        { method: 'POST', body: { wait_ms: POLL_WAIT_MS } },
        config,
      )) as { job: Job | null } | null;

      const job = result?.job ?? null;

      // Reset backoff state on any successful response (job or null).
      authFailures = 0;
      transientBackoffMs = TRANSIENT_BACKOFF_MIN_MS;

      if (job) {
        // Run the job asynchronously so the poll loop continues immediately.
        // For now there is no concurrency limit — jobs run one at a time because
        // the poll loop blocks here. A later version can add a task pool.
        await executeJob(job, config);
      }

      // If job was null (timeout), immediately re-poll — no sleep needed.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuth = err instanceof ApiError && (err.status === 401 || err.status === 403);

      if (isAuth) {
        authFailures++;
        console.error(`[poll] auth error (${authFailures}/${AUTH_FAIL_LIMIT}):`, msg);
        if (authFailures >= AUTH_FAIL_LIMIT) {
          stop(`poll hit ${AUTH_FAIL_LIMIT} consecutive 401s — token likely revoked, re-run \`workgraph login\``);
          return;
        }
        await sleep(AUTH_BACKOFF_MS);
      } else {
        console.error('[poll] error:', msg);
        // Exponential with full jitter, capped. Keeps multiple agents from
        // marching in lockstep when the server briefly returns 5xx.
        const jittered = Math.floor(Math.random() * transientBackoffMs);
        await sleep(Math.max(TRANSIENT_BACKOFF_MIN_MS, jittered));
        transientBackoffMs = Math.min(transientBackoffMs * 2, TRANSIENT_BACKOFF_MAX_MS);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Job execution
// ────────────────────────────────────────────────────────────────

async function executeJob(job: Job, config: AgentConfig): Promise<void> {
  console.log(`[job ${job.id}] received kind=${job.kind}`);

  const sink = new EventSink(job.id, config);

  let result: Awaited<ReturnType<typeof dispatch>>;
  try {
    result = await dispatch(job, sink, config);
  } catch (err) {
    result = {
      status: 'failed',
      error: `agent internal error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Close sink BEFORE posting result so the server has all events before
  // seeing the terminal status.
  await sink.close();

  try {
    if (result.status === 'done') {
      await apiFetch(
        `/api/agent/jobs/${job.id}/result`,
        { method: 'POST', body: { status: 'done', result: result.payload } },
        config,
      );
    } else if (result.status === 'defer') {
      await apiFetch(
        `/api/agent/jobs/${job.id}/result`,
        {
          method: 'POST',
          body: {
            status: 'defer',
            retry_after_seconds: result.retry_after_seconds,
            error: result.error,
          },
        },
        config,
      );
    } else {
      await apiFetch(
        `/api/agent/jobs/${job.id}/result`,
        { method: 'POST', body: { status: 'failed', error: result.error } },
        config,
      );
    }
  } catch (err) {
    // If we can't post the result, the server will re-queue via its stale-job timeout.
    console.error(
      `[job ${job.id}] failed to post result:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Claude CLI detection — exported so status.ts can reuse it.
// ────────────────────────────────────────────────────────────────

/**
 * Generic binary-on-PATH detection. Spawns `<bin> <versionFlag>` with a
 * 2s timeout, returns availability + version string. Used by the
 * heartbeat to report claude / codex / gemini availability uniformly.
 */
export async function detectCli(bin: string, versionFlag = '--version'): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ available: false });
    }, 2000);

    const child = spawn(bin, [versionFlag], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.trim()) {
        resolve({ available: true, version: output.trim() });
      } else {
        resolve({ available: false });
      }
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve({ available: false });
    });
  });
}

/** Backwards-compatible wrapper — kept so existing callers still build. */
export async function detectClaudeCli(): Promise<{ available: boolean; version?: string }> {
  return detectCli('claude');
}

// ────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
