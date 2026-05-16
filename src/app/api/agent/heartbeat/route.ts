/**
 * POST /api/agent/heartbeat
 *
 * Liveness signal from the agent. Updates agents.last_seen_at and stores
 * optional metadata (hostname, platform, version).
 *
 * Auth: Bearer token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface HeartbeatBody {
  hostname?: string;
  platform?: string;
  version?: string;
  // Capabilities — preferred nested shape sent by the agent.
  claude_cli?: { available?: boolean; version?: string };
  codex_cli?:  { available?: boolean; version?: string };
  gemini_cli?: { available?: boolean; version?: string };
  // Legacy flat shape, accepted for backwards compatibility.
  claude_available?: boolean;
  claude_version?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const identity = await verifyAgentToken(req);
  if (!identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: HeartbeatBody = {};
  try {
    body = (await req.json()) as HeartbeatBody;
  } catch {
    // heartbeat body is optional; proceed with empty body
  }

  // Normalise capability shape — prefer nested *_cli over flat fields.
  const claudeAvailable = body.claude_cli?.available ?? body.claude_available ?? null;
  const claudeVersion   = body.claude_cli?.version   ?? body.claude_version   ?? null;
  const codexAvailable  = body.codex_cli?.available  ?? null;
  const codexVersion    = body.codex_cli?.version    ?? null;
  const geminiAvailable = body.gemini_cli?.available ?? null;
  const geminiVersion   = body.gemini_cli?.version   ?? null;

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  await db
    .prepare(
      `UPDATE agents
       SET last_seen_at     = datetime('now'),
           hostname         = COALESCE(?, hostname),
           platform         = COALESCE(?, platform),
           version          = COALESCE(?, version),
           claude_available = COALESCE(?, claude_available),
           claude_version   = COALESCE(?, claude_version),
           codex_available  = COALESCE(?, codex_available),
           codex_version    = COALESCE(?, codex_version),
           gemini_available = COALESCE(?, gemini_available),
           gemini_version   = COALESCE(?, gemini_version)
       WHERE id = ?`,
    )
    .run(
      body.hostname ?? null,
      body.platform ?? null,
      body.version ?? null,
      claudeAvailable === null ? null : claudeAvailable ? 1 : 0,
      claudeVersion,
      codexAvailable === null ? null : codexAvailable ? 1 : 0,
      codexVersion,
      geminiAvailable === null ? null : geminiAvailable ? 1 : 0,
      geminiVersion,
      identity.agentId,
    );

  return NextResponse.json({ ok: true });
}
