import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface HeartbeatBody {
  hostname?: string;
  platform?: string;
  version?: string;
}

interface AgentRow {
  hostname: string | null;
  platform: string | null;
  version: string | null;
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  const identity = await verifyAgentRequest(req);
  if (!identity) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body: HeartbeatBody = await req.json().catch(() => ({}));
  const db = getLibsqlDb();

  const current = await db
    .prepare(
      `SELECT hostname, platform, version
       FROM workspace_agents
       WHERE agent_id = ?
       LIMIT 1`,
    )
    .get<AgentRow>(identity.agentId);

  // Merge: only overwrite if the agent provided a value.
  const hostname = body.hostname ?? current?.hostname ?? null;
  const platform = body.platform ?? current?.platform ?? null;
  const version = body.version ?? current?.version ?? null;

  await db
    .prepare(
      `UPDATE workspace_agents
       SET last_seen_at = datetime('now'),
           status = 'online',
           hostname = ?,
           platform = ?,
           version = ?
       WHERE agent_id = ?`,
    )
    .run(hostname, platform, version, identity.agentId);

  return NextResponse.json({ ok: true });
}
