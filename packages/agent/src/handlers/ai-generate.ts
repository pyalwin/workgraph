/**
 * ai-generate — handler for kind `ai.generate`.
 *
 * Lets a Vercel-deployed (or remote) workgraph server route arbitrary
 * `runPrompt({task})` calls through the user's local agent + Claude
 * installation, bypassing the need for CLI binaries on the server's PATH.
 *
 * Job params:
 *   { task, system, prompt, maxOutputTokens }
 *
 * The handler streams Claude with --bare (pure summarization, no tools)
 * and accumulates text. Returns the assembled string as the job payload
 * so the server-side runPrompt poll can return it directly to its caller.
 *
 * Rate-limit policy: same ANTHROPIC_POLICY as gmail.classify. Persistent
 * 429s defer the job for 1h server-side, agent moves on to other work.
 */

import type { JobHandler } from '../dispatcher.js';
import { ANTHROPIC_POLICY, detectRateLimit, shortBackoffMs } from '../rate-limit-policy.js';
import { streamCodex } from '../drivers/codex.js';
import { streamGemini } from '../drivers/gemini.js';
import type { RuntimeEvent } from '../types.js';

interface AIGenerateParams {
  cli?: unknown;        // 'claude' | 'codex' | 'gemini' — picks which driver to invoke
  task?: unknown;
  system?: unknown;
  prompt?: unknown;
  maxOutputTokens?: unknown;
}

const POLICY = ANTHROPIC_POLICY;
const SUPPORTED_CLIS = new Set(['claude', 'codex', 'gemini']);

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export const aiGenerateHandler: JobHandler = async (job, ctx) => {
  const params = (job.params || {}) as AIGenerateParams;
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const system = typeof params.system === 'string' ? params.system : '';
  const task = typeof params.task === 'string' ? params.task : 'enrich';
  const cli = typeof params.cli === 'string' ? params.cli : 'claude';
  if (!prompt.trim()) {
    return { status: 'failed', error: 'missing prompt' };
  }
  if (!SUPPORTED_CLIS.has(cli)) {
    return {
      status: 'failed',
      error: `cli '${cli}' not yet supported by this agent (drivers ship later)`,
    };
  }

  let rateLimitAttempt = 0;

  while (true) {
    let collected = '';
    const stderrLines: string[] = [];
    let finishReason = 'unknown';

    // Route to the right CLI driver. Claude uses the canonical injectable
    // stream from JobContext (testable, used in unit tests). Codex / Gemini
    // call their drivers directly since the context doesn't expose them.
    let stream: AsyncIterable<RuntimeEvent>;
    if (cli === 'claude') {
      stream = ctx.streamClaude({
        prompt,
        systemPrompt: system,
        disableTools: true,
      } as any);
    } else if (cli === 'codex') {
      stream = streamCodex({
        prompt,
        systemPrompt: system,
        disableTools: true,
      });
    } else {
      stream = streamGemini({
        prompt,
        systemPrompt: system,
        disableTools: true,
      });
    }

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
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log('warn', `[ai.generate] stream error: ${msg}`);
    }

    // Rate-limit detection — same pattern as gmail.classify.
    const haystack = `${stderrLines.join('\n')}\n${collected}`;
    const rateLimited =
      detectRateLimit(haystack, POLICY) || finishReason === 'rate_limited';

    if (rateLimited) {
      rateLimitAttempt += 1;
      if (rateLimitAttempt <= POLICY.short_retries) {
        const backoff = shortBackoffMs(rateLimitAttempt);
        ctx.log(
          'warn',
          `[ai.generate task=${task}] ${POLICY.label} rate-limit (short-retry ${rateLimitAttempt}/${POLICY.short_retries}); waiting ${backoff}ms`,
        );
        await sleep(backoff);
        continue;
      }
      ctx.log(
        'warn',
        `[ai.generate task=${task}] ${POLICY.label} rate-limit persists; deferring ${POLICY.defer_seconds}s`,
      );
      return {
        status: 'defer',
        retry_after_seconds: POLICY.defer_seconds,
        error: `${POLICY.label} rate-limit after ${rateLimitAttempt} attempts`,
      };
    }

    const text = collected.trim();
    if (!text) {
      return { status: 'failed', error: `empty response (finish=${finishReason})` };
    }
    ctx.log('info', `[ai.generate task=${task}] ${text.length} chars (${rateLimitAttempt + 1} attempt${rateLimitAttempt > 0 ? 's' : ''})`);
    return { status: 'done', payload: { text } };
  }
};
