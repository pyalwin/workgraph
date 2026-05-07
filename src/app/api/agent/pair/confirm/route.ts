/**
 * POST /api/agent/pair/confirm
 *
 * User submits their user_code to approve a pending agent pairing.
 * Auth: browser session (withAuth) — user must be signed in.
 *
 * Body: { user_code: string }
 * Returns: { ok: true, agent_id: string }
 *
 * Flow:
 *   1. Look up agent_pairing by user_code.
 *   2. Verify status === 'pending' and not expired.
 *   3. Create an agents row owned by the current user's workspace.
 *   4. Generate a raw bearer token; store its hash in agents.token_hash.
 *   5. Write agent_id + raw token into the pairing row (poll endpoint reads
 *      agent_token_raw once, then clears it).
 *   6. Mark pairing as 'confirmed'.
 */

import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { generateAgentToken, hashToken } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface PairingRow {
  id: string;
  status: string;
  expires_at: string;
  agent_id: string | null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { user_code?: unknown };
  try {
    body = (await req.json()) as { user_code?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.user_code !== 'string' || !body.user_code.trim()) {
    return NextResponse.json({ error: 'user_code is required' }, { status: 400 });
  }

  const userCode = body.user_code.trim().toUpperCase();

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const pairing = await db
    .prepare(
      `SELECT id, status, expires_at, agent_id
       FROM agent_pairing
       WHERE user_code = ?
       LIMIT 1`,
    )
    .get<PairingRow>(userCode);

  if (!pairing) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 404 });
  }

  if (pairing.status !== 'pending') {
    if (pairing.status === 'confirmed') {
      return NextResponse.json({ error: 'Code already used' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Code expired or invalid' }, { status: 410 });
  }

  if (Date.parse(pairing.expires_at) < Date.now()) {
    await db
      .prepare(`UPDATE agent_pairing SET status = 'expired' WHERE id = ?`)
      .run(pairing.id);
    return NextResponse.json({ error: 'Code has expired' }, { status: 410 });
  }

  // Resolve workspace for this user — simple heuristic: use 'default' for now.
  // The same pattern as resolveAlmanacWorkspaceId but without a projectKey.
  const workspaceRow = await db
    .prepare(
      `SELECT id FROM workspace_config WHERE enabled = 1 ORDER BY id ASC LIMIT 1`,
    )
    .get<{ id: string }>();
  const workspaceId = workspaceRow?.id ?? 'default';

  const agentId = uuid();
  const rawToken = generateAgentToken();
  const tokenHash = hashToken(rawToken);

  // Create the agent row.
  await db
    .prepare(
      `INSERT INTO agents (id, workspace_id, user_id, token_hash, paired_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(agentId, workspaceId, user.id, tokenHash);

  // Confirm the pairing with agent_id + raw token (poll endpoint reads this once).
  await db
    .prepare(
      `UPDATE agent_pairing
       SET status = 'confirmed', agent_id = ?, agent_token_raw = ?
       WHERE id = ?`,
    )
    .run(agentId, rawToken, pairing.id);

  return NextResponse.json({ ok: true, agent_id: agentId });
}
