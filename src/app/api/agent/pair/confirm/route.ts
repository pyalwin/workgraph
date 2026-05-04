import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { mintAgentToken, hashUserCode } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface PairingRow {
  pairing_id: string;
}

export async function POST(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();

  const body = (await req.json()) as { user_code?: string };
  const userCode = body.user_code;
  if (!userCode) {
    return NextResponse.json({ error: 'missing user_code' }, { status: 400 });
  }

  const db = getLibsqlDb();
  const codeHash = hashUserCode(userCode);

  const pairing = await db
    .prepare(
      `SELECT pairing_id FROM agent_pairings
       WHERE code_hash = ? AND status = 'pending' AND expires_at > datetime('now')
       LIMIT 1`,
    )
    .get<PairingRow>(codeHash);

  if (!pairing) {
    return NextResponse.json({ error: 'invalid_or_expired_code' }, { status: 404 });
  }

  const agentId = uuidv4();
  const { token, tokenHash } = mintAgentToken();

  await db
    .prepare(
      `INSERT INTO workspace_agents
         (agent_id, user_id, workspace_id, pairing_token_enc, status)
       VALUES (?, ?, 'all', ?, 'offline')`,
    )
    .run(agentId, user.id, tokenHash);

  // Raw token stored transiently in agent_token_enc; /poll returns it once and nulls it.
  await db
    .prepare(
      `UPDATE agent_pairings
       SET status = 'confirmed', user_id = ?, agent_id = ?, agent_token_enc = ?
       WHERE pairing_id = ?`,
    )
    .run(user.id, agentId, token, pairing.pairing_id);

  return NextResponse.json({ ok: true, agent_id: agentId, hostname: null });
}
