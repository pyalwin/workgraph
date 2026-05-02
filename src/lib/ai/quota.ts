import { getActiveProviderId, type AITask } from './index';
import { getMonthlyUsage } from './usage-store';

/**
 * Free-tier enforcement. We only meter operator-paid Gateway calls — BYOK
 * (OpenRouter/etc.) and local-agent calls bypass the cap because the user
 * already pays for those.
 *
 * Two caps run in parallel:
 *   - Cost cap (primary, in micros = 1/1_000_000 USD). Tracks actual spend.
 *     Default $1.00/workspace/month. Override via WORKGRAPH_FREE_LIMIT_USD_MICROS.
 *   - Call-count cap (secondary anti-abuse). Default 1000/workspace/month.
 *     Override via WORKGRAPH_FREE_LIMIT_TOTAL. Prevents pathological spam
 *     even on cheap models that wouldn't ring up the cost cap.
 *
 * Either cap exceeded → block. Set the env var to `unlimited`/`0`/`-1` to
 * disable the corresponding cap (useful for self-hosted operators).
 */

const DEFAULT_COST_LIMIT_USD_MICROS = 1_000_000; // $1.00 / workspace / month
const DEFAULT_TOTAL_CALLS_LIMIT = 1_000;

export interface QuotaInfo {
  enforced: boolean;
  period: string;
  activeProvider: 'gateway' | 'openrouter';
  // Primary cap — cost
  costLimitUsdMicros: number | null;
  costUsedUsdMicros: number;
  costRemainingUsdMicros: number | null;
  // Secondary cap — call count
  callLimit: number | null;
  callUsed: number;
  callRemaining: number | null;
}

export class QuotaExceededError extends Error {
  readonly task: AITask;
  readonly reason: 'cost' | 'calls';
  readonly used: number;
  readonly limit: number;

  constructor(task: AITask, reason: 'cost' | 'calls', used: number, limit: number) {
    const human =
      reason === 'cost'
        ? `Free-tier monthly budget reached ($${(used / 1_000_000).toFixed(2)} of $${(limit / 1_000_000).toFixed(2)}).`
        : `Free-tier monthly call limit reached (${used} of ${limit} calls).`;
    super(`${human} Add an OpenRouter key or install the WorkGraph Agent to keep going.`);
    this.name = 'QuotaExceededError';
    this.task = task;
    this.reason = reason;
    this.used = used;
    this.limit = limit;
  }
}

function readLimitFromEnv(envName: string, fallback: number): number | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'unlimited' || raw === '0' || raw === '-1') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getQuota(workspaceId: string): Promise<QuotaInfo> {
  const activeProvider = getActiveProviderId();
  const usage = await getMonthlyUsage(workspaceId);

  const costLimit = readLimitFromEnv('WORKGRAPH_FREE_LIMIT_USD_MICROS', DEFAULT_COST_LIMIT_USD_MICROS);
  const callLimit = readLimitFromEnv('WORKGRAPH_FREE_LIMIT_TOTAL', DEFAULT_TOTAL_CALLS_LIMIT);

  const enforced = activeProvider === 'gateway' && (costLimit !== null || callLimit !== null);

  return {
    enforced,
    period: usage.period,
    activeProvider,
    costLimitUsdMicros: costLimit,
    costUsedUsdMicros: usage.totalCostUsdMicros,
    costRemainingUsdMicros:
      costLimit === null ? null : Math.max(0, costLimit - usage.totalCostUsdMicros),
    callLimit,
    callUsed: usage.totalCalls,
    callRemaining: callLimit === null ? null : Math.max(0, callLimit - usage.totalCalls),
  };
}

export async function precheckQuota(workspaceId: string, task: AITask): Promise<QuotaInfo> {
  const q = await getQuota(workspaceId);
  if (!q.enforced) return q;

  if (q.costLimitUsdMicros !== null && q.costUsedUsdMicros >= q.costLimitUsdMicros) {
    throw new QuotaExceededError(task, 'cost', q.costUsedUsdMicros, q.costLimitUsdMicros);
  }
  if (q.callLimit !== null && q.callUsed >= q.callLimit) {
    throw new QuotaExceededError(task, 'calls', q.callUsed, q.callLimit);
  }
  return q;
}
