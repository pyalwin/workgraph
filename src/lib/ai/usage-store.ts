import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import type { AITask } from './index';

/**
 * Free-tier metering store. Operator-paid AI Gateway calls are recorded here
 * (per workspace, per month, per task). BYOK calls and local-agent calls are
 * NOT recorded — the user pays directly there, no quota to enforce.
 *
 * Async libSQL path — works in dev (file:) and prod (libsql:).
 */

const ALL_TASKS: AITask[] = [
  'enrich',
  'recap',
  'extract',
  'project-summary',
  'decision',
  'narrative',
  'chat',
];

export interface UsageEntry {
  task: AITask;
  callCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicros: number;
  lastAt: string | null;
}

export interface MonthlyUsage {
  workspaceId: string;
  period: string;
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsdMicros: number;
  byTask: UsageEntry[];
}

export interface UsageDelta {
  tokensIn?: number;
  tokensOut?: number;
  costUsdMicros?: number;
}

let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function recordUsage(workspaceId: string, task: AITask, delta: UsageDelta = {}): Promise<void> {
  await ensureInit();
  const period = currentPeriod();
  const tin = Math.max(0, Math.round(delta.tokensIn ?? 0));
  const tout = Math.max(0, Math.round(delta.tokensOut ?? 0));
  const cost = Math.max(0, Math.round(delta.costUsdMicros ?? 0));

  await getLibsqlDb()
    .prepare(
      `INSERT INTO workspace_ai_usage
         (workspace_id, period, task, call_count, tokens_in, tokens_out, cost_usd_micros, last_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, datetime('now'))
       ON CONFLICT(workspace_id, period, task) DO UPDATE SET
         call_count       = workspace_ai_usage.call_count + 1,
         tokens_in        = workspace_ai_usage.tokens_in + excluded.tokens_in,
         tokens_out       = workspace_ai_usage.tokens_out + excluded.tokens_out,
         cost_usd_micros  = workspace_ai_usage.cost_usd_micros + excluded.cost_usd_micros,
         last_at          = excluded.last_at`,
    )
    .run(workspaceId, period, task, tin, tout, cost);
}

export async function getMonthlyUsage(workspaceId: string, period?: string): Promise<MonthlyUsage> {
  await ensureInit();
  const p = period ?? currentPeriod();
  const rows = await getLibsqlDb()
    .prepare(
      `SELECT task, call_count, tokens_in, tokens_out, cost_usd_micros, last_at
       FROM workspace_ai_usage
       WHERE workspace_id = ? AND period = ?`,
    )
    .all<{
      task: AITask;
      call_count: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd_micros: number;
      last_at: string | null;
    }>(workspaceId, p);

  const byTaskMap = new Map<AITask, UsageEntry>();
  for (const t of ALL_TASKS) {
    byTaskMap.set(t, { task: t, callCount: 0, tokensIn: 0, tokensOut: 0, costUsdMicros: 0, lastAt: null });
  }
  for (const r of rows) {
    byTaskMap.set(r.task, {
      task: r.task,
      callCount: r.call_count,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costUsdMicros: r.cost_usd_micros,
      lastAt: r.last_at,
    });
  }

  const byTask = [...byTaskMap.values()];
  const totalCalls = byTask.reduce((s, e) => s + e.callCount, 0);
  const totalTokensIn = byTask.reduce((s, e) => s + e.tokensIn, 0);
  const totalTokensOut = byTask.reduce((s, e) => s + e.tokensOut, 0);
  const totalCostUsdMicros = byTask.reduce((s, e) => s + e.costUsdMicros, 0);

  return {
    workspaceId,
    period: p,
    totalCalls,
    totalTokensIn,
    totalTokensOut,
    totalCostUsdMicros,
    byTask,
  };
}
