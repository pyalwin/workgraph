import type { CliBackend } from './types';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { geminiBackend } from './gemini';

export type { CliBackend, CliBackendOptions, CliEvent } from './types';

export const CLI_BACKENDS: Record<string, CliBackend> = {
  claude: claudeBackend,
  codex: codexBackend,
  gemini: geminiBackend,
};

// claude / codex / gemini all execute on the user's paired local agent
// (the @workgraph/agent process). The web server enqueues into agent_jobs
// and the agent runs the matching CLI on its own machine. NEVER spawns a
// binary in the web server process — that path was wrong by design and
// only ever appeared to work in local dev where the laptop happens to be
// both the web server and the agent host.
export type BackendId = 'sdk' | 'claude' | 'codex' | 'gemini';

export function getCliBackend(id: string): CliBackend | null {
  return CLI_BACKENDS[id] ?? null;
}

/** Heartbeat freshness window — agent posts every ~30s; allow 90s slack. */
const AGENT_HEARTBEAT_WINDOW_MS = 90_000;

interface AgentReport {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

/**
 * Look up the workspace's most-recent paired agent and read which CLIs it
 * reports as locally available. Returns all-false if no agent, stale
 * heartbeat, or DB lookup fails. The schema only stores claude_available
 * today; codex and gemini columns are planned (agent's heartbeat needs
 * extending to report them).
 */
async function readAgentReport(workspaceId: string | undefined): Promise<AgentReport> {
  const off: AgentReport = { claude: false, codex: false, gemini: false };
  if (!workspaceId) return off;
  try {
    const { getLibsqlDb } = await import('@/lib/db/libsql');
    const db = getLibsqlDb();
    const row = await db
      .prepare(
        `SELECT last_seen_at, claude_available, codex_available, gemini_available
         FROM agents
         WHERE workspace_id = ?
         ORDER BY last_seen_at DESC NULLS LAST
         LIMIT 1`,
      )
      .get<{
        last_seen_at: string | null;
        claude_available: number | null;
        codex_available: number | null;
        gemini_available: number | null;
      }>(workspaceId);
    if (!row?.last_seen_at) return off;
    // SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" with no timezone marker;
    // `Date.parse` treats it as LOCAL time and silently shifts the age by
    // the server's offset. Force-UTC by switching to ISO-8601 + 'Z'.
    const ageMs = Date.now() - Date.parse(row.last_seen_at.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ageMs) || ageMs > AGENT_HEARTBEAT_WINDOW_MS) return off;
    return {
      claude: row.claude_available === 1,
      codex:  row.codex_available  === 1,
      gemini: row.gemini_available === 1,
    };
  } catch {
    return off;
  }
}

/**
 * Backend availability uses the workspace's paired agent as the source
 * of truth, not the web server's PATH. Without a workspace context we
 * return all-CLI-unavailable (web server can't tell what your laptop has).
 */
export async function listAvailableBackends(
  workspaceId?: string,
): Promise<Array<{ id: BackendId; label: string; available: boolean; reason?: string }>> {
  const report = await readAgentReport(workspaceId);
  const hasWorkspaceCtx = !!workspaceId;
  const offlineReason = hasWorkspaceCtx
    ? 'agent not paired or offline'
    : 'agent status unknown';

  const cli = [
    { id: 'claude' as const, label: 'Claude Code', available: report.claude, ...(report.claude ? {} : { reason: offlineReason }) },
    { id: 'codex' as const,  label: 'Codex',       available: report.codex,  ...(report.codex  ? {} : { reason: offlineReason }) },
    { id: 'gemini' as const, label: 'Gemini',      available: report.gemini, ...(report.gemini ? {} : { reason: offlineReason }) },
  ];

  return [
    { id: 'sdk' as const, label: 'Vercel AI SDK', available: true },
    ...cli,
  ];
}
