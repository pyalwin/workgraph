import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { mintUserCode, hashUserCode, PAIRING_TTL_SECONDS } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

// v1: ignores optional hostname/platform/version in request body;
// the agent's first heartbeat will populate those fields.
export async function POST(req: Request) {
  await ensureSchemaAsync();

  const pairingId = uuidv4();
  const userCode = mintUserCode();
  const codeHash = hashUserCode(userCode);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString();
  const db = getLibsqlDb();

  await db
    .prepare(
      `INSERT INTO agent_pairings (pairing_id, code_hash, status, expires_at)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(pairingId, codeHash, expiresAt);

  const base =
    process.env.WORKGRAPH_URL ?? new URL(req.url).origin;

  return NextResponse.json({
    pairing_id: pairingId,
    user_code: userCode,
    verification_url: `${base}/agent/pair?code=${userCode}`,
    expires_in: PAIRING_TTL_SECONDS,
  });
}
