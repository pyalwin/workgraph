/**
 * generic runtime — the universal handler for jobs that provide CLI params
 * rather than a registered custom handler.
 *
 * Expected job.params shape:
 * {
 *   cli: 'claude' | 'codex' | 'gemini',
 *   prompt: string,
 *   system_prompt?: string,
 *   model?: string,
 *   allowed_tools?: string[],
 *   disallowed_tools?: string[],
 *   repo: string,          // 'owner/name'
 *   ref?: string,          // default 'main'
 *   post_to?: { url: string; body_extra?: Record<string, unknown> },
 * }
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Job, JobResult } from '../types.js';
import type { JobContext } from '../dispatcher.js';

const SESSIONS_DIR = join(homedir(), '.workgraph', 'sessions');

interface GenericParams {
  cli: 'claude' | 'codex' | 'gemini';
  prompt: string;
  system_prompt?: string;
  model?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  repo: string;
  ref?: string;
  post_to?: { url: string; body_extra?: Record<string, unknown> };
}

/**
 * Validates and narrows the generic params shape.
 * Returns an error string if invalid, or undefined if valid.
 */
function validateParams(params: Record<string, unknown>): { valid: GenericParams } | { error: string } {
  if (params['cli'] !== 'claude' && params['cli'] !== 'codex' && params['cli'] !== 'gemini') {
    return { error: `invalid cli: ${String(params['cli'])} — must be 'claude', 'codex', or 'gemini'` };
  }
  if (typeof params['prompt'] !== 'string' || !params['prompt']) {
    return { error: `params.prompt must be a non-empty string` };
  }
  if (typeof params['repo'] !== 'string' || !params['repo']) {
    return { error: `params.repo must be a non-empty string (e.g. 'owner/name')` };
  }
  if (params['system_prompt'] !== undefined && typeof params['system_prompt'] !== 'string') {
    return { error: `params.system_prompt must be a string if provided` };
  }
  if (params['model'] !== undefined && typeof params['model'] !== 'string') {
    return { error: `params.model must be a string if provided` };
  }
  if (params['allowed_tools'] !== undefined && !Array.isArray(params['allowed_tools'])) {
    return { error: `params.allowed_tools must be an array if provided` };
  }
  if (params['disallowed_tools'] !== undefined && !Array.isArray(params['disallowed_tools'])) {
    return { error: `params.disallowed_tools must be an array if provided` };
  }
  if (params['post_to'] !== undefined) {
    const pt = params['post_to'];
    if (typeof pt !== 'object' || pt === null || typeof (pt as Record<string, unknown>)['url'] !== 'string') {
      return { error: `params.post_to must be an object with a 'url' string if provided` };
    }
  }

  return {
    valid: {
      cli: params['cli'] as 'claude' | 'codex' | 'gemini',
      prompt: params['prompt'] as string,
      system_prompt: params['system_prompt'] as string | undefined,
      model: params['model'] as string | undefined,
      allowed_tools: params['allowed_tools'] as string[] | undefined,
      disallowed_tools: params['disallowed_tools'] as string[] | undefined,
      repo: params['repo'] as string,
      ref: typeof params['ref'] === 'string' ? params['ref'] : undefined,
      post_to: params['post_to'] as GenericParams['post_to'],
    },
  };
}

/**
 * Atomically write a file: write to a temp path then rename.
 */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

/**
 * Persist the Claude session ID to ~/.workgraph/sessions/<job_id>.json
 * using an atomic write so a crash mid-write doesn't corrupt the file.
 */
async function persistSessionId(jobId: string, sessionId: string): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const path = join(SESSIONS_DIR, `${jobId}.json`);
  await atomicWrite(path, JSON.stringify({ job_id: jobId, session_id: sessionId, saved_at: new Date().toISOString() }, null, 2));
}

export async function genericRuntime(job: Job, ctx: JobContext): Promise<JobResult> {
  // ── Validate params ────────────────────────────────────────────────────────
  const validation = validateParams(job.params);
  if ('error' in validation) {
    return { status: 'failed', error: validation.error };
  }
  const params = validation.valid;

  // ── Only Claude is implemented in v1 ──────────────────────────────────────
  if (params.cli !== 'claude') {
    return { status: 'failed', error: `driver '${params.cli}' not implemented in v1` };
  }

  // ── Resolve workspace ──────────────────────────────────────────────────────
  let workspacePath: string;
  let workspaceSha: string;
  try {
    const ws = await ctx.resolveWorkspace({ repoKey: params.repo, ref: params.ref ?? 'main' });
    workspacePath = ws.path;
    workspaceSha = ws.sha;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `workspace resolver error: ${msg}` };
  }

  ctx.sink.emit({
    type: 'log',
    level: 'info',
    message: `[generic] workspace resolved: ${workspacePath} @ ${workspaceSha}`,
  });

  // ── Stream Claude ──────────────────────────────────────────────────────────
  let accumulatedText = '';
  let finishReason: 'stop' | 'error' | 'cancelled' = 'stop';

  const claudeStream = ctx.streamClaude({
    prompt: params.prompt,
    systemPrompt: params.system_prompt,
    model: params.model,
    cwd: workspacePath,
    allowedTools: params.allowed_tools,
    disallowedTools: params.disallowed_tools,
  });

  for await (const event of claudeStream) {
    ctx.sink.emit(event);
    if (event.type === 'text-delta') {
      accumulatedText += event.text;
    }
    if (event.type === 'finish') {
      finishReason = event.reason;
    }
  }

  // ── Persist session ID (if captured) ─────────────────────────────────────
  const sessionId = claudeStream.sessionId;
  if (sessionId) {
    try {
      await persistSessionId(job.id, sessionId);
    } catch (err) {
      // Non-fatal — log but don't fail the job.
      ctx.log('warn', `[generic] failed to persist session ID: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Optional POST to post_to ───────────────────────────────────────────────
  let postToStatus: number | undefined;
  if (params.post_to) {
    const { url, body_extra } = params.post_to;
    try {
      const body = { ...body_extra, text: accumulatedText };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      postToStatus = res.status;
      if (!res.ok) {
        ctx.log('warn', `[generic] post_to ${url} returned HTTP ${res.status}`);
      }
    } catch (err) {
      ctx.log('warn', `[generic] post_to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (finishReason === 'error' || finishReason === 'cancelled') {
    return {
      status: 'failed',
      error: `job finished with reason: ${finishReason}`,
    };
  }

  const result: Record<string, unknown> = {
    chars: accumulatedText.length,
    ref: workspaceSha,
  };
  if (postToStatus !== undefined) {
    result['post_to_status'] = postToStatus;
  }

  return { status: 'done', payload: result };
}

/**
 * Returns true if the job params look like a generic-runtime job.
 * Used by the dispatcher to fall through to generic when no handler is found.
 */
export function isGenericJob(params: Record<string, unknown>): boolean {
  return (
    typeof params['cli'] === 'string' &&
    typeof params['prompt'] === 'string' &&
    typeof params['repo'] === 'string'
  );
}
