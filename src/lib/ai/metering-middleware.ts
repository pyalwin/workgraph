import type { LanguageModelV3Middleware, LanguageModelV3Usage } from '@ai-sdk/provider';
import { getActiveProviderId, type AITask } from './index';
import { estimateCostMicros } from './pricing';
import { precheckQuota } from './quota';
import { recordUsage } from './usage-store';

/**
 * Provider-level usage type splits inputTokens/outputTokens into nested
 * objects with cache breakdowns; we only care about totals.
 */
function flattenUsage(usage: LanguageModelV3Usage | undefined): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: usage?.inputTokens?.total ?? 0,
    outputTokens: usage?.outputTokens?.total ?? 0,
  };
}

const DEFAULT_WORKSPACE_ID = process.env.WORKGRAPH_WORKSPACE_ID?.trim() || 'default';

/**
 * Wraps every getModel(task) call so all AI generation — sync, project-summary,
 * decisions, narratives, chat — runs through the same precheck/record path.
 *
 * Without this, callers that bypass src/lib/ai/runner.ts (most of the codebase)
 * would silently skip the cap, and a single historical-sync run could blow
 * past the monthly free-tier budget. The middleware fixes that without
 * touching every call site.
 *
 * Behavior:
 *   - precheck on transformParams (throws QuotaExceededError if over cap)
 *   - record on wrapGenerate (after the response, with token counts)
 *   - record on wrapStream (when the stream emits its final chunk)
 *   - both are no-ops when the active provider isn't the operator-paid Gateway
 *     (BYOK and CLI paths bypass — user pays directly there).
 */
export function meteringMiddleware(
  task: AITask,
  modelId: string,
  workspaceId?: string,
): LanguageModelV3Middleware {
  const wsId = workspaceId ?? DEFAULT_WORKSPACE_ID;

  const isMetered = () => getActiveProviderId() === 'gateway';

  const persist = async (inputTokens: number, outputTokens: number) => {
    try {
      const costUsdMicros = estimateCostMicros(modelId, inputTokens, outputTokens);
      await recordUsage(wsId, task, { tokensIn: inputTokens, tokensOut: outputTokens, costUsdMicros });
    } catch (err) {
      console.warn(`[ai metering] recordUsage failed: ${(err as Error).message}`);
    }
  };

  return {
    specificationVersion: 'v3',

    transformParams: async ({ params }) => {
      if (isMetered()) await precheckQuota(wsId, task);
      return params;
    },

    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      if (isMetered()) {
        const u = flattenUsage(result.usage);
        await persist(u.inputTokens, u.outputTokens);
      }
      return result;
    },

    wrapStream: async ({ doStream }) => {
      const out = await doStream();
      if (!isMetered()) return out;

      const recorded = { done: false };
      const transformed = out.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!recorded.done && (chunk as { type?: string }).type === 'finish') {
              const usage = (chunk as { usage?: LanguageModelV3Usage }).usage;
              const u = flattenUsage(usage);
              // Fire-and-forget — stream backpressure shouldn't wait on a DB write.
              void persist(u.inputTokens, u.outputTokens);
              recorded.done = true;
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return { ...out, stream: transformed };
    },
  };
}
