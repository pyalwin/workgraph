/**
 * POST /api/agent/pair/start
 *
 * Begins a device-flow pairing. Returns a short user_code the user enters on
 * the confirmation page (UI not in this slice). Expires in 10 minutes.
 *
 * Does NOT require authentication — the agent calls this before it has any
 * credentials. The user_code is the anti-abuse gate.
 */

import { NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

// 6-char code using unambiguous characters (no 0/O, I/1/l).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateUserCode(): string {
  let code = '';
  // Use Math.random for this non-secret display code; the real secret is the
  // agent_token that is only revealed after user confirmation.
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();

    const id = uuid();
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();

    await db
      .prepare(
        `INSERT INTO agent_pairing (id, user_code, status, expires_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(id, userCode, expiresAt);

    // Prefer the configured public URL; fall back to the request origin so
    // the response is always a complete URL the agent can print.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
    const verificationUrl = `${origin}/agents/connect?code=${userCode}`;

    return NextResponse.json({
      pairing_id: id,
      user_code: userCode,
      verification_url: verificationUrl,
      expires_at: expiresAt,
    });
  } catch (err) {
    // Surface the message so the agent CLI gets something actionable
    // instead of an empty 500 body. Beta-phase debug aid.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pair/start] failed:', err);
    return NextResponse.json(
      { error: 'pair_start_failed', message },
      { status: 500 },
    );
  }
}
