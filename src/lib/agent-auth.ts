/**
 * Agent bearer-token authentication.
 *
 * Tokens are cryptographically random opaque strings (≥32 bytes).
 * Only the SHA-256 hash is stored in agents.token_hash.
 * Comparison uses timingSafeEqual to prevent timing attacks.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

export interface AgentIdentity {
  agentId: string;
  workspaceId: string;
  userId: string;
}

/** Generate a new opaque bearer token (raw, never stored). */
export function generateAgentToken(): string {
  return randomBytes(32).toString('hex');
}

/** Hash a raw token for storage. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded SHA-256 digests.
 * Returns true only if they are identical.
 */
function secureCompareHex(a: string, b: string): boolean {
  // Both must be the same length for timingSafeEqual to work without leaking.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Validate `Authorization: Bearer <token>` from an incoming request.
 *
 * Returns the agent's identity on success, or null on any failure.
 * Callers should respond with 401 when null is returned.
 */
export async function verifyAgentToken(
  req: NextRequest | Request,
): Promise<AgentIdentity | null> {
  const authHeader = req.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const raw = authHeader.slice('Bearer '.length).trim();
  if (!raw) return null;

  const incoming = hashToken(raw);

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Load all active agents (number is small — one per paired machine).
  // We do a constant-time comparison client-side so as not to leak timing
  // through the database lookup.
  const rows = await db
    .prepare(
      `SELECT id, workspace_id, user_id, token_hash
       FROM agents
       ORDER BY paired_at DESC`,
    )
    .all<{ id: string; workspace_id: string; user_id: string; token_hash: string }>();

  for (const row of rows) {
    if (secureCompareHex(incoming, row.token_hash)) {
      return {
        agentId: row.id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
      };
    }
  }

  return null;
}
