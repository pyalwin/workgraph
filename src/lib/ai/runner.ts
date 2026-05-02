import { generateText } from 'ai';
import { getModel, type AITask } from '@/lib/ai';
import { getCliBackend, type BackendId } from '@/lib/ai/cli-backends';
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

  const cli = getCliBackend(backend);
  if (!cli || !(await cli.isAvailable())) {
    console.warn(`[runPrompt] backend '${backend}' unavailable, falling back to SDK for task '${opts.task}'`);
    return runSdk(opts);
  }

  let collected = '';
  let aborted = false;
  try {
    for await (const evt of cli.stream({
      prompt: opts.prompt,
      systemPrompt: opts.system ?? '',
      cwd: process.cwd(),
      disableTools: true, // workflow prompts are pure summarization
    })) {
      if (evt.type === 'text-delta') collected += evt.text;
      else if (evt.type === 'error') {
        console.warn(`[runPrompt] ${cli.label} error: ${evt.message}`);
        aborted = true;
        break;
      } else if (evt.type === 'finish') break;
    }
  } catch (err) {
    console.warn(`[runPrompt] ${cli.label} threw: ${(err as Error).message}`);
    aborted = true;
  }

  // CLI returned empty or errored — fall back to SDK rather than persisting noise.
  if (aborted || !collected.trim()) {
    return runSdk(opts);
  }

  return { text: collected.trim(), backend };
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
