import os from "node:os";
import { apiFetch } from "../client.js";
import { readConfig } from "../config.js";
import { getHandler } from "../jobs/registry.js";

// Injected at build time by tsc from package.json — keep in sync manually.
// Using a static string avoids a require() or JSON.parse at runtime in ESM.
const AGENT_VERSION = "0.1.0";

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_WAIT_MS = 25_000;
const RETRY_DELAY_MS = 5_000;

interface Job {
  id: string;
  kind: string;
  params: unknown;
  attempt: number;
}

interface PollResponse {
  job: Job | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.error("Not paired. Run `workgraph login` first.");
    process.exit(1);
  }

  console.log(`Agent starting — connected to ${config.url} as ${config.agent_id}`);

  // Shared cancellation flag. Both loops check this before each iteration.
  // On SIGINT we flip it and let the current fetch/sleep finish naturally
  // rather than calling process.exit() immediately, so in-flight job results
  // are still sent before the process exits.
  let running = true;
  const stopPromises: Array<() => void> = [];

  process.on("SIGINT", () => {
    console.log("\nShutting down…");
    running = false;
    // Wake any sleeping loops immediately so they can exit.
    for (const wake of stopPromises) wake();
  });

  // Interruptible sleep: stores a resolver that SIGINT can call to unblock early.
  function sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      stopPromises.push(wake);
      // Clean up after it fires naturally so the array doesn't grow unboundedly.
      void Promise.resolve().then(() => {
        const idx = stopPromises.indexOf(wake);
        if (idx !== -1) stopPromises.splice(idx, 1);
      });
    });
  }

  async function heartbeatLoop(): Promise<void> {
    while (running) {
      try {
        await apiFetch("/api/agent/heartbeat", {
          method: "POST",
          body: {
            hostname: os.hostname(),
            platform: process.platform,
            version: AGENT_VERSION,
          },
        });
      } catch (err) {
        console.error(
          "Heartbeat error:",
          err instanceof Error ? err.message : String(err)
        );
        await sleepInterruptible(RETRY_DELAY_MS);
        continue;
      }
      await sleepInterruptible(HEARTBEAT_INTERVAL_MS);
    }
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      let pollData: PollResponse;
      try {
        pollData = (await apiFetch("/api/agent/jobs/poll", {
          method: "POST",
          body: { wait_ms: POLL_WAIT_MS },
        })) as PollResponse;
      } catch (err) {
        console.error(
          "Poll error:",
          err instanceof Error ? err.message : String(err)
        );
        await sleepInterruptible(RETRY_DELAY_MS);
        continue;
      }

      if (!pollData.job) continue;

      const job = pollData.job;
      const handler = getHandler(job.kind);

      if (!handler) {
        console.error(`Unknown job kind: ${job.kind} (id=${job.id})`);
        try {
          await apiFetch("/api/agent/jobs/result", {
            method: "POST",
            body: {
              job_id: job.id,
              status: "failed",
              error: `Unknown job kind: ${job.kind}`,
            },
          });
        } catch (err) {
          console.error(
            "Failed to report unknown-kind failure:",
            err instanceof Error ? err.message : String(err)
          );
        }
        continue;
      }

      try {
        const result = await handler(job.params);
        await apiFetch("/api/agent/jobs/result", {
          method: "POST",
          body: { job_id: job.id, status: "done", result },
        });
        console.log(`Job ${job.id} (${job.kind}) completed.`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`Job ${job.id} (${job.kind}) failed: ${error}`);
        try {
          await apiFetch("/api/agent/jobs/result", {
            method: "POST",
            body: { job_id: job.id, status: "failed", error },
          });
        } catch (reportErr) {
          console.error(
            "Failed to report job failure:",
            reportErr instanceof Error ? reportErr.message : String(reportErr)
          );
        }
      }
    }
  }

  await Promise.all([heartbeatLoop(), pollLoop()]);
  console.log("Agent stopped.");
}
