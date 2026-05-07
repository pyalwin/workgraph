/**
 * POST /api/agent/pair/poll
 *
 * Agent polls here after displaying the user_code, waiting for the user to
 * confirm on the web UI. Returns:
 *   - status: 'pending' | 'confirmed' | 'expired'
 *   - on confirmed: agent_id, agent_token (raw, shown ONCE here)
 *
 * The confirmation step (user clicks confirm in the UI) writes workspace_id,
 * user_id, status='confirmed', agent_id, agent_token_raw into agent_pairing.
 * That confirmation route is NOT in this slice.
 *
 * No auth required — the pairing_id is a sufficient opaque credential.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface PairingRow {
  id: string;
  status: string;
  agent_id: string | null;
  agent_token_raw: string | null;
  expires_at: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const pairingId =
    body && typeof body === 'object' && 'pairing_id' in body
      ? (body as Record<string, unknown>).pairing_id
      : undefined;

  if (typeof pairingId !== 'string' || !pairingId) {
    return NextResponse.json({ error: 'pairing_id is required' }, { status: 400 });
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const row = await db
    .prepare(
      `SELECT id, status, agent_id, agent_token_raw, expires_at
       FROM agent_pairing
       WHERE id = ?`,
    )
    .get<PairingRow>(pairingId);

  if (!row) {
    return NextResponse.json({ error: 'Unknown pairing_id' }, { status: 404 });
  }

  const expired = Date.parse(row.expires_at) < Date.now();

  if (row.status === 'pending' && expired) {
    // Mark expired for hygiene (best-effort).
    await db.prepare(`UPDATE agent_pairing SET status = 'expired' WHERE id = ?`).run(row.id);
    return NextResponse.json({ status: 'expired' });
  }

  if (row.status === 'expired') {
    return NextResponse.json({ status: 'expired' });
  }

  if (row.status === 'confirmed' && row.agent_id && row.agent_token_raw) {
    // Clear the raw token from the pairing row — it's been consumed.
    await db
      .prepare(`UPDATE agent_pairing SET agent_token_raw = NULL WHERE id = ?`)
      .run(row.id);

    return NextResponse.json({
      status: 'confirmed',
      agent_id: row.agent_id,
      agent_token: row.agent_token_raw,
    });
  }

  return NextResponse.json({ status: 'pending' });
}
