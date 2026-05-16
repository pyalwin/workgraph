import { generateText } from 'ai';
import { getModel, type AITask } from '@/lib/ai';
import type { BackendId } from '@/lib/ai/cli-backends';
import { getTaskBackend } from '@/lib/ai/task-backend-store';

export interface RunPromptOptions {
  task: AITask;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  /**
   * Force a specific backend. Overrides env-var config. If the requested
   * backend isn't available (CLI not installed), falls back to SDK.
   */
  backend?: BackendId;
}

// Re-exported for callers that catch the typed error to render a friendly
// "you hit the cap" upsell instead of a generic 500.
export { QuotaExceededError } from '@/lib/ai/quota';

/**
 * Resolve which backend handles a given task. Resolution order:
 *   1. UI-persisted setting (Settings → AI → Task routing).
 *   2. Per-task env var: `WORKGRAPH_AI_BACKEND_<TASK>` (uppercase, hyphens
 *      → underscores, e.g. `WORKGRAPH_AI_BACKEND_PROJECT_SUMMARY=claude`).
 *   3. Global env var: `WORKGRAPH_AI_BACKEND` (applies to all tasks).
 *   4. Default: `'sdk'` (Vercel AI Gateway).
 */
function resolveBackendForTask(task: AITask): BackendId {
  try {
    const stored = getTaskBackend(task);
    if (stored) return stored;
  } catch {
    // store not initialized — fall through to env vars
  }
  const key = `WORKGRAPH_AI_BACKEND_${task.toUpperCase().replace(/-/g, '_')}`;
  const taskSpecific = process.env[key];
  if (isValidBackend(taskSpecific)) return taskSpecific;
  const global = process.env.WORKGRAPH_AI_BACKEND;
  if (isValidBackend(global)) return global;
  return 'sdk';
}

function isValidBackend(v: string | undefined): v is BackendId {
  return v === 'sdk' || v === 'claude' || v === 'codex' || v === 'gemini';
}

/**
 * One-shot text generation with the same shape regardless of backend.
 * Replaces direct `generateText({ model: getModel(task), prompt })` calls
 * for workflows that want pluggable backends.
 *
 * SDK path: cheap, fast, parallelizable — best for high-volume sync jobs.
 * CLI path: subscription pricing + access to stronger models (Opus, GPT-5,
 * Gemini Pro). Tools are disabled by default since workflow prompts are
 * pure summarization, not agentic exploration.
 */
export async function runPrompt(opts: RunPromptOptions): Promise<{ text: string; backend: BackendId }> {
  const backend = opts.backend ?? resolveBackendForTask(opts.task);

  if (backend === 'sdk') {
    return runSdk(opts);
  }

  // All CLI backends (claude / codex / gemini) execute on the user's
  // paired local agent — never spawn binaries in the web server process.
  // The agent picks up the agent_jobs(kind='ai.generate') row, runs the
  // appropriate driver, posts the result back. We poll for completion
  // and fall back to SDK on timeout / unpaired agent / agent failure.
  if (backend === 'claude' || backend === 'codex' || backend === 'gemini') {
    const result = await runViaLocalAgent(opts, backend);
    if (result) return { text: result, backend };
    console.warn(`[runPrompt] ${backend} via local agent unavailable; falling back to SDK for task '${opts.task}'`);
    return runSdk(opts);
  }

  // Unknown backend — log + SDK fallback.
  console.warn(`[runPrompt] unknown backend '${backend}'; falling back to SDK for task '${opts.task}'`);
  return runSdk(opts);
}

async function runSdk(opts: RunPromptOptions): Promise<{ text: string; backend: BackendId }> {
  // Quota precheck + usage recording happen inside getModel()'s metering
  // middleware, so every AI call (sync, project-summary, decisions, chat)
  // is metered uniformly — not just runner-routed paths. Throws
  // QuotaExceededError from generateText when the cap is reached.
  const { text } = await generateText({
    model: getModel(opts.task),
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
  });
  return { text, backend: 'sdk' };
}

/**
 * Dispatch the prompt to the workspace's local agent. Inserts an
 * agent_jobs(kind='ai.generate') row and polls for the result. Returns
 * null on no-paired-agent / timeout / job failure so the caller can fall
 * back to SDK.
 *
 * Polling interval starts tight (1s) and backs off to keep idle load low.
 * Default total timeout 4 minutes — long enough for slow Claude turns,
 * short enough that synchronous sync flows don't hang forever if the
 * agent goes offline mid-run.
 */
async function runViaLocalAgent(
  opts: RunPromptOptions,
  cli: 'claude' | 'codex' | 'gemini' = 'claude',
): Promise<string | null> {
  const POLL_INITIAL_MS = 1_000;
  const POLL_MAX_MS = 5_000;
  const TIMEOUT_MS = 4 * 60 * 1000;

  const { v4: uuid } = await import('uuid');
  const { getLibsqlDb } = await import('@/lib/db/libsql');
  const db = getLibsqlDb();

  // Find a paired agent for the active workspace with recent heartbeat.
  let workspaceId: string | null = null;
  try {
    const { getActiveWorkspaceId } = await import('@/lib/active-workspace');
    workspaceId = await getActiveWorkspaceId();
  } catch {
    return null; // no request context (e.g. inngest worker without workspace) — can't dispatch
  }
  if (!workspaceId) return null;

  const agent = await db
    .prepare(
      `SELECT id, last_seen_at FROM agents
       WHERE workspace_id = ?
       ORDER BY last_seen_at DESC NULLS LAST
       LIMIT 1`,
    )
    .get<{ id: string; last_seen_at: string | null }>(workspaceId);
  if (!agent?.last_seen_at) return null;
  const ageMs = Date.now() - Date.parse(agent.last_seen_at);
  if (!Number.isFinite(ageMs) || ageMs > 90_000) return null; // stale heartbeat

  // Enqueue the job. Params carry everything the agent's ai.generate
  // handler needs to reconstruct the call.
  const jobId = uuid();
  const params = JSON.stringify({
    cli,                                  // which CLI the agent should run
    task: opts.task,
    system: opts.system ?? '',
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens ?? 800,
  });
  try {
    await db
      .prepare(
        `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
         VALUES (?, ?, 'ai.generate', 'queued', ?)`,
      )
      .run(jobId, workspaceId, params);
  } catch {
    return null;
  }

  // Poll until terminal.
  const deadline = Date.now() + TIMEOUT_MS;
  let interval = POLL_INITIAL_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((res) => setTimeout(res, interval));
    interval = Math.min(POLL_MAX_MS, Math.floor(interval * 1.5));
    const row = await db
      .prepare(`SELECT status, result FROM agent_jobs WHERE id = ?`)
      .get<{ status: string; result: string | null }>(jobId);
    if (!row) return null;
    if (row.status === 'done') {
      try {
        const parsed = row.result ? JSON.parse(row.result) : null;
        if (typeof parsed === 'string') return parsed;
        if (parsed && typeof parsed.text === 'string') return parsed.text;
        return null;
      } catch {
        return row.result; // raw text
      }
    }
    if (row.status === 'failed' || row.status === 'cancelled') {
      console.warn(`[runPrompt local-agent] job ${jobId} ${row.status}`);
      return null;
    }
    // 'queued' / 'assigned' — keep polling
  }
  console.warn(`[runPrompt local-agent] job ${jobId} timed out after ${TIMEOUT_MS}ms`);
  return null;
}
