import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { readConfig } from '../config.js';
import { apiFetch } from '../client.js';
import { EventSink } from '../sink.js';
import { dispatch } from '../dispatcher.js';
import { registerAllHandlers } from '../handlers/index.js';
import { AGENT_VERSION } from '../version.js';
import type { Job, AgentConfig } from '../types.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_WAIT_MS = 25_000;
const ERROR_BACKOFF_MS = 5_000;

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

  // Run both loops concurrently. Each loop exits when `running` becomes false.
  await Promise.all([heartbeatLoop(config, () => running), pollLoop(config, () => running)]);

  console.log('Agent stopped.');
}

// ────────────────────────────────────────────────────────────────
// Heartbeat loop — fires every 30 s while running.
// ────────────────────────────────────────────────────────────────

async function heartbeatLoop(config: AgentConfig, isRunning: () => boolean): Promise<void> {
  // Send an initial heartbeat immediately.
  await sendHeartbeat(config);

  while (isRunning()) {
    await sleep(HEARTBEAT_INTERVAL_MS);
    if (!isRunning()) break;
    await sendHeartbeat(config);
  }
}

async function sendHeartbeat(config: AgentConfig): Promise<void> {
  const claudeCli = await detectClaudeCli();
  const payload = {
    hostname: hostname(),
    platform: platform(),
    version: AGENT_VERSION,
    claude_cli: claudeCli,
  };
  try {
    await apiFetch('/api/agent/heartbeat', { method: 'POST', body: payload }, config);
  } catch (err) {
    // Heartbeat failure is non-fatal — just log and continue.
    console.warn('[heartbeat] error:', err instanceof Error ? err.message : String(err));
  }
}

// ────────────────────────────────────────────────────────────────
// Poll loop — long-polls for the next job.
// ────────────────────────────────────────────────────────────────

async function pollLoop(config: AgentConfig, isRunning: () => boolean): Promise<void> {
  while (isRunning()) {
    try {
      const result = (await apiFetch(
        '/api/agent/jobs/poll',
        { method: 'POST', body: { wait_ms: POLL_WAIT_MS } },
        config,
      )) as { job: Job | null } | null;

      const job = result?.job ?? null;

      if (job) {
        // Run the job asynchronously so the poll loop continues immediately.
        // For now there is no concurrency limit — jobs run one at a time because
        // the poll loop blocks here. A later version can add a task pool.
        await executeJob(job, config);
      }

      // If job was null (timeout), immediately re-poll — no sleep needed.
    } catch (err) {
      console.error('[poll] error:', err instanceof Error ? err.message : String(err));
      // Back off before retrying to avoid hammering on persistent errors.
      await sleep(ERROR_BACKOFF_MS);
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

export async function detectClaudeCli(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ available: false });
    }, 2000);

    const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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

// ────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
