/**
 * gmail-classify — handler for kind `gmail.classify`.
 *
 * Job params (from the Inngest orchestrator):
 *   { item_id, source_id, title, body, author, metadata: { participants?: [], ... } }
 *
 * Flow:
 *   1. Build a thread-classification prompt (same schema the inline web
 *      path uses) — model returns JSON with { category, topics, summary, entities }.
 *   2. Stream Claude with --bare and disabled tools (pure summarization).
 *   3. Accumulate text-deltas, parse first JSON object out of the response.
 *   4. On 429 / rate-limit: short in-process retries (2s, 4s) per the
 *      provider policy; if the provider stays rate-limited, return
 *      { status: 'defer', retry_after_seconds } so the server reschedules
 *      the job for hours-later. The agent moves on to other work rather
 *      than blocking on a recovery that takes hours.
 *   5. Return { status: 'done', payload: classification } — the server-side
 *      result handler maps it into tags/entity_mentions/summary via
 *      persistGmailClassification.
 */

import type { JobHandler } from '../dispatcher.js';
import {
  ANTHROPIC_POLICY,
  detectRateLimit,
  shortBackoffMs,
} from '../rate-limit-policy.js';

interface GmailParams {
  item_id?: unknown;
  source_id?: unknown;
  title?: unknown;
  body?: unknown;
  author?: unknown;
  metadata?: { participants?: unknown } | null | unknown;
}

const ALLOWED_CATEGORIES = [
  'finance', 'fundraising', 'hiring', 'sales', 'vendor', 'product',
  'support', 'internal', 'legal', 'personal', 'newsletter', 'other',
] as const;

const SYSTEM_PROMPT = `You analyze Gmail threads for a knowledge graph. Return ONLY a single JSON object — no prose, no code fences.

Schema:
{
  "category": one of: ${ALLOWED_CATEGORIES.join(' | ')},
  "topics": array of 1-3 short kebab-case tags derived from content,
  "summary": one sentence, <= 160 chars, describing what the thread is about,
  "entities": array of named entities mentioned IN THE BODY (not just the From/To headers)
              — each: { "kind": "organization" | "person" | "product", "name": "..." }
}

Topic-tag rules:
- Kebab-case, 1-3 words. Examples: "credit-card", "invoice", "investor-update", "candidate-interview".
- GENERIC enough that two semantically similar threads receive the same tag.
- Topical, not entity-named. Use "credit-card" not "chase-credit-card"; "investor-update" not "sequoia-update".
- 1-3 tags max.

Entity rules:
- Extract NAMED entities mentioned in the body — companies, people, products.
- DO NOT extract email participants from headers (already captured server-side).
- Use canonical names. Up to 6 entities.

Output ONLY the JSON object.`;

// Provider policy: this handler hits Anthropic via the Claude CLI. The
// policy module dictates in-process retry count and defer duration.
const POLICY = ANTHROPIC_POLICY;
// Cap on attempts including JSON parse failures (separate from rate-limit
// short_retries). After this many we mark failed.
const MAX_PARSE_ATTEMPTS = 2;

function extractFirstJsonObject(text: string): string | null {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

function sanitizeTopic(s: string): string | null {
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!t || t.length > 40) return null;
  return t;
}

function buildPrompt(params: GmailParams): string {
  const title = String(params.title ?? '(no subject)');
  const body = String(params.body ?? '').slice(0, 4000);
  const metadata = (params.metadata && typeof params.metadata === 'object'
    ? (params.metadata as { participants?: unknown }) : {});
  const participants = Array.isArray(metadata.participants)
    ? (metadata.participants as unknown[]).map((p) => String(p)).slice(0, 12)
    : [];
  return `Subject: ${title}\nParticipants: ${participants.join(', ') || '(none)'}\n\nBody:\n${body}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export const gmailClassifyHandler: JobHandler = async (job, ctx) => {
  const params = (job.params || {}) as GmailParams;
  const itemId = String(params.item_id ?? '');
  if (!itemId) {
    return { status: 'failed', error: 'missing item_id in params' };
  }

  const prompt = buildPrompt(params);
  let rateLimitAttempt = 0;
  let parseAttempt = 0;
  let lastError = '';

  while (true) {
    let collected = '';
    const stderrLines: string[] = [];
    let finishReason = 'unknown';

    const stream = ctx.streamClaude({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      // No tools — pure summarization. --bare bypasses CLAUDE.md/hooks too.
      disableTools: true,
    } as any);

    try {
      for await (const evt of stream as AsyncIterable<{ type: string; [k: string]: unknown }>) {
        if (evt.type === 'text-delta' && typeof evt.text === 'string') {
          collected += evt.text;
        } else if (evt.type === 'log') {
          const m = String((evt as any).message ?? '');
          if (m) stderrLines.push(m);
        } else if (evt.type === 'finish') {
          finishReason = String((evt as any).reason ?? 'stop');
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // Rate-limit detection — combined provider-policy pattern match
    // against the stderr stream AND the model's response body (some
    // providers surface 429 as a text message rather than an HTTP error).
    const haystack = `${stderrLines.join('\n')}\n${collected}`;
    const rateLimited =
      detectRateLimit(haystack, POLICY) || finishReason === 'rate_limited';

    if (rateLimited) {
      rateLimitAttempt += 1;
      if (rateLimitAttempt <= POLICY.short_retries) {
        const backoff = shortBackoffMs(rateLimitAttempt);
        ctx.log(
          'warn',
          `[gmail.classify] ${POLICY.label} rate-limit (short-retry ${rateLimitAttempt}/${POLICY.short_retries}); waiting ${backoff}ms`,
        );
        await sleep(backoff);
        continue;
      }
      // Exhausted short retries — defer to the server queue. Agent
      // releases the job and moves on; server marks status='queued'
      // with next_retry_at set per policy, so the next poll skips
      // this row until the cooldown expires.
      ctx.log(
        'warn',
        `[gmail.classify] ${POLICY.label} rate-limit persists; deferring ${POLICY.defer_seconds}s`,
      );
      return {
        status: 'defer',
        retry_after_seconds: POLICY.defer_seconds,
        error: `${POLICY.label} rate-limit after ${rateLimitAttempt} attempts`,
      };
    }

    // Try to parse a valid classification out of whatever we got.
    const json = extractFirstJsonObject(collected);
    if (!json) {
      parseAttempt += 1;
      lastError = lastError || `no JSON in response (finish=${finishReason})`;
      if (parseAttempt < MAX_PARSE_ATTEMPTS) continue;
      return { status: 'failed', error: `parse: ${lastError}` };
    }

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const rawCategory = String(parsed.category ?? '').toLowerCase().trim();
      const category = (ALLOWED_CATEGORIES as readonly string[]).includes(rawCategory)
        ? rawCategory
        : 'other';
      const topics = Array.isArray(parsed.topics)
        ? (parsed.topics as unknown[])
            .map((t) => sanitizeTopic(String(t)))
            .filter((t): t is string => !!t)
            .slice(0, 3)
        : [];
      const summary = String(parsed.summary ?? '').trim().slice(0, 240);
      const rawEntities = Array.isArray(parsed.entities) ? (parsed.entities as unknown[]) : [];
      const entities: Array<{ kind: 'organization' | 'person' | 'product'; name: string }> = [];
      for (const e of rawEntities) {
        if (!e || typeof e !== 'object') continue;
        const er = e as { kind?: unknown; name?: unknown };
        const kind = String(er.kind ?? '').toLowerCase().trim();
        const name = String(er.name ?? '').trim();
        if (!name || name.length > 80) continue;
        if (kind !== 'organization' && kind !== 'person' && kind !== 'product') continue;
        entities.push({ kind: kind as 'organization' | 'person' | 'product', name });
        if (entities.length >= 6) break;
      }

      const totalAttempts = rateLimitAttempt + parseAttempt + 1;
      ctx.log(
        'info',
        `[gmail.classify] ${itemId} → ${category} [${topics.join(',')}] (${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''})`,
      );

      return {
        status: 'done',
        payload: { category, topics, summary, entities },
      };
    } catch (err) {
      parseAttempt += 1;
      lastError = err instanceof Error ? err.message : String(err);
      if (parseAttempt < MAX_PARSE_ATTEMPTS) continue;
      return { status: 'failed', error: `parse: ${lastError}` };
    }
  }
};
