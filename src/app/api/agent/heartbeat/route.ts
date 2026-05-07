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

  // Normalise capability shape — prefer nested claude_cli over flat fields.
  const claudeAvailable =
    body.claude_cli?.available ??
    body.claude_available ??
    null;
  const claudeVersion =
    body.claude_cli?.version ??
    body.claude_version ??
    null;

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
           claude_version   = COALESCE(?, claude_version)
       WHERE id = ?`,
    )
    .run(
      body.hostname ?? null,
      body.platform ?? null,
      body.version ?? null,
      claudeAvailable === null ? null : claudeAvailable ? 1 : 0,
      claudeVersion,
      identity.agentId,
    );

  return NextResponse.json({ ok: true });
}
