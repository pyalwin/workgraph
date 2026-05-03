import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface PairingRow {
  pairing_id: string;
  status: string;
  expires_at: string;
  agent_id: string | null;
  agent_token_enc: string | null;
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  const body = (await req.json()) as { pairing_id?: string };
  const pairingId = body.pairing_id;
  if (!pairingId) {
    return NextResponse.json({ error: 'missing pairing_id' }, { status: 400 });
  }

  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT pairing_id, status, expires_at, agent_id, agent_token_enc
       FROM agent_pairings WHERE pairing_id = ? LIMIT 1`,
    )
    .get<PairingRow>(pairingId);

  if (!row || new Date(row.expires_at) <= new Date()) {
    // Mark expired in passing so future polls short-circuit faster.
    if (row && row.status !== 'expired') {
      await db
        .prepare(`UPDATE agent_pairings SET status = 'expired' WHERE pairing_id = ?`)
        .run(pairingId);
    }
    return NextResponse.json({ status: 'expired' }, { status: 410 });
  }

  if (row.status === 'pending') {
    return NextResponse.json({ status: 'pending' });
  }

  if (row.status === 'confirmed') {
    // Raw token stored transiently here; /poll returns it once and nulls it.
    const agentToken = row.agent_token_enc!;
    const agentId = row.agent_id!;
    await db
      .prepare(
        `UPDATE agent_pairings SET status = 'consumed', agent_token_enc = NULL WHERE pairing_id = ?`,
      )
      .run(pairingId);
    return NextResponse.json({ status: 'confirmed', agent_id: agentId, agent_token: agentToken });
  }

  // status is 'consumed' or 'expired'
  return NextResponse.json({ status: row.status }, { status: 410 });
}
