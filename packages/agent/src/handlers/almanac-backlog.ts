/**
 * almanac.backlog — handler for kind `almanac.backlog`.
 *
 * Job params: { workspaceId, projectKey, repoKey, ref }
 *
 * Flow:
 *   1. Validate params.
 *   2. Resolve workspace (clone/fetch/checkout at ref).
 *   3. Stream Claude with a read-only inspection prompt focused on
 *      "what could be done" (todos) and "what could be built" (features).
 *   4. Parse JSON; one retry on malformed output.
 *   5. POST items to /api/projects/<projectKey>/backlog/ingest.
 *
 * Distinct from almanac.outline because this output is small, list-shaped,
 * and ingested into a separate user-managed surface (project_backlog_items).
 */

import type { JobHandler } from '../dispatcher.js';

const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const DISALLOWED_TOOLS = ['Edit', 'Write', 'WebFetch', 'Task', 'NotebookEdit'];

const KIND_VALUES = ['todo', 'feature'] as const;
type ItemKind = (typeof KIND_VALUES)[number];

interface BacklogItem {
  kind: ItemKind;
  title: string;
  description: string;
  evidence?: {
    paths?: string[];
    refs?: string[];
    commits?: string[];
    notes?: string;
  };
}

interface Output {
  items: BacklogItem[];
}

interface Params {
  workspaceId: string;
  projectKey: string;
  repoKey: string;
  ref: string;
}

function validateParams(raw: Record<string, unknown>): { valid: Params } | { error: string } {
  const required = ['workspaceId', 'projectKey', 'repoKey', 'ref'] as const;
  for (const k of required) {
    if (typeof raw[k] !== 'string' || !raw[k]) {
      return { error: `params.${k} must be a non-empty string` };
    }
  }
  return {
    valid: {
      workspaceId: raw['workspaceId'] as string,
      projectKey: raw['projectKey'] as string,
      repoKey: raw['repoKey'] as string,
      ref: raw['ref'] as string,
    },
  };
}

function buildPrompt(): string {
  return `You are inspecting a repository to populate a project backlog. Output a SHORT, CURATED list (max 20 items) of two kinds:

  - kind = "todo": concrete actionable work items. Examples:
      • TODO/FIXME comments worth tracking (pull from code with Grep)
      • Missing tests for a major module
      • Outdated dependency / security advisory
      • Missing CI step (lint, type-check, test)
      • Missing documentation (no README, no contributor guide)
      • Stub functions that throw "not implemented"

  - kind = "feature": *speculative* additions a reasonable engineer might
    propose for this product. Examples:
      • A capability the README hints at but isn't built yet
      • A natural extension of an existing feature
      • Integrations the project mentions but doesn't have

For each item provide:
  - kind: "todo" | "feature"
  - title: short imperative phrase, ≤ 12 words ("Add tests for OAuth callback flow")
  - description: 1–3 sentences with the WHY and any pointers
  - evidence: {
      paths: file paths (max 5) you found this in,
      refs: TODO/issue refs you saw,
      notes: any extra context
    }

Rules:
  - Maximum 20 items total. Quality over quantity.
  - 60-70% should be "todo" (concrete), 30-40% "feature" (speculative).
  - NEVER invent paths or commits — only cite ones you actually inspected.
  - If the repo is small or has no real backlog, return fewer items (or zero).
  - Skip generic recommendations ("add tests") — be specific to THIS repo.

How to inspect:
  - Read README first to understand purpose
  - Glob for tests/* and CI files (.github/workflows)
  - Grep for TODO/FIXME/HACK
  - Read package manifest (package.json / Cargo.toml / etc.) for deps
  - Sample 2-3 main source files to gauge code maturity

Output MUST be a single, strictly valid JSON object:

{
  "items": [
    {
      "kind": "todo" | "feature",
      "title": "<string>",
      "description": "<string>",
      "evidence": { "paths": ["<path>"], "refs": ["<ref>"], "notes": "<string>" }
    }
  ]
}

CRITICAL output rules:
  - Output ONLY the JSON object. No markdown fences. No preamble. No trailing prose.
  - Must be parseable by JSON.parse() with no preprocessing.
  - Strings must not contain unescaped newlines or tabs.
  - Empty items array is acceptable.`;
}

function buildRetryPrompt(malformed: string): string {
  return `Your previous response was not valid JSON. Here is what you returned:

---BEGIN PREVIOUS RESPONSE---
${malformed.slice(0, 8000)}${malformed.length > 8000 ? '\n...[truncated]' : ''}
---END PREVIOUS RESPONSE---

Please fix it. Return ONLY a valid JSON object matching this schema:

{
  "items": [
    { "kind": "todo" | "feature", "title": "<string>", "description": "<string>",
      "evidence": { "paths": ["<string>"], "refs": ["<string>"], "notes": "<string>" } }
  ]
}

Output ONLY the corrected JSON object now.`;
}

function validateOutput(parsed: unknown): { valid: Output } | { error: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'output must be a JSON object' };
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o['items'])) {
    return { error: 'output.items must be an array' };
  }
  const items: BacklogItem[] = [];
  for (let i = 0; i < o['items'].length; i++) {
    const raw = o['items'][i];
    if (typeof raw !== 'object' || raw === null) {
      return { error: `items[${i}] must be an object` };
    }
    const r = raw as Record<string, unknown>;
    if (r['kind'] !== 'todo' && r['kind'] !== 'feature') {
      return { error: `items[${i}].kind must be 'todo' or 'feature'` };
    }
    if (typeof r['title'] !== 'string' || !r['title'].trim()) {
      return { error: `items[${i}].title must be a non-empty string` };
    }
    if (typeof r['description'] !== 'string') {
      return { error: `items[${i}].description must be a string` };
    }
    const evidenceRaw = r['evidence'];
    let evidence: BacklogItem['evidence'];
    if (evidenceRaw && typeof evidenceRaw === 'object' && !Array.isArray(evidenceRaw)) {
      const e = evidenceRaw as Record<string, unknown>;
      const ev: BacklogItem['evidence'] = {};
      if (Array.isArray(e['paths'])) ev.paths = e['paths'].filter((v): v is string => typeof v === 'string');
      if (Array.isArray(e['refs'])) ev.refs = e['refs'].filter((v): v is string => typeof v === 'string');
      if (Array.isArray(e['commits'])) ev.commits = e['commits'].filter((v): v is string => typeof v === 'string');
      if (typeof e['notes'] === 'string') ev.notes = e['notes'];
      evidence = ev;
    }
    items.push({
      kind: r['kind'] as ItemKind,
      title: (r['title'] as string).trim(),
      description: (r['description'] as string).trim(),
      evidence,
    });
  }
  return { valid: { items } };
}

async function drainStream(
  stream: ReturnType<import('../dispatcher.js').JobContext['streamClaude']>,
  sink: import('../dispatcher.js').JobContext['sink'],
): Promise<{ text: string; finishReason: 'stop' | 'error' | 'cancelled' }> {
  let text = '';
  let finishReason: 'stop' | 'error' | 'cancelled' = 'stop';
  for await (const event of stream) {
    sink.emit(event);
    if (event.type === 'text-delta') text += event.text;
    if (event.type === 'finish') finishReason = event.reason;
  }
  return { text, finishReason };
}

export const almanacBacklogHandler: JobHandler = async (job, ctx) => {
  ctx.log('info', `[almanac.backlog] job ${job.id} starting`);

  const validation = validateParams(job.params);
  if ('error' in validation) {
    return { status: 'failed', error: validation.error };
  }
  const params = validation.valid;

  let workspacePath: string;
  let sha: string;
  try {
    const ws = await ctx.resolveWorkspace({ repoKey: params.repoKey, ref: params.ref });
    workspacePath = ws.path;
    sha = ws.sha;
  } catch (err) {
    return {
      status: 'failed',
      error: `workspace resolver error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  ctx.log('info', `[almanac.backlog] workspace ${workspacePath} @ ${sha}`);

  // First Claude call.
  const firstStream = ctx.streamClaude({
    prompt: buildPrompt(),
    cwd: workspacePath,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
  });
  const { text: firstText, finishReason: firstFinish } = await drainStream(firstStream, ctx.sink);
  if (firstFinish === 'error' || firstFinish === 'cancelled') {
    return { status: 'failed', error: `Claude stream ended with reason: ${firstFinish}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstText.trim());
  } catch {
    ctx.log('warn', '[almanac.backlog] JSON parse failed — retrying with fix prompt');
    const retryStream = ctx.streamClaude({
      prompt: buildRetryPrompt(firstText.trim()),
      cwd: workspacePath,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    });
    const { text: retryText, finishReason: retryFinish } = await drainStream(retryStream, ctx.sink);
    if (retryFinish === 'error' || retryFinish === 'cancelled') {
      return { status: 'failed', error: `Claude retry stream ended with reason: ${retryFinish}` };
    }
    try {
      parsed = JSON.parse(retryText.trim());
    } catch {
      return { status: 'failed', error: 'backlog JSON invalid after retry' };
    }
  }

  const validationResult = validateOutput(parsed);
  if ('error' in validationResult) {
    return { status: 'failed', error: `backlog validation failed: ${validationResult.error}` };
  }
  const output = validationResult.valid;

  ctx.log('info', `[almanac.backlog] ${output.items.length} item(s) — posting to /api/projects/${params.projectKey}/backlog/ingest`);

  let postStatus: number | undefined;
  try {
    await ctx.client(`/api/projects/${params.projectKey}/backlog/ingest`, {
      method: 'POST',
      body: { items: output.items },
    });
    postStatus = 200;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log('warn', `[almanac.backlog] POST failed: ${msg}`);
    return {
      status: 'done',
      payload: { items: output.items.length, ref: sha, post_status: 0, post_error: msg },
    };
  }

  return {
    status: 'done',
    payload: { items: output.items.length, ref: sha, post_status: postStatus },
  };
};
