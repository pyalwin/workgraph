import { createHash, randomBytes } from 'crypto';
import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

/**
 * Local-agent auth helpers.
 *
 * The local agent (npm `@workgraph/agent`) authenticates to the control plane
 * with an opaque Bearer token. We store sha256(token) in
 * `workspace_agents.pairing_token_enc` (the column was scaffolded pre-Almanac;
 * for Phase 0 we use it as the lookup hash — encryption isn't needed because
 * the value is already a one-way hash and the raw token only ever lives on
 * the user's laptop).
 *
 * Token format:
 *   wga_<base64url(32 random bytes)>
 *
 * The `wga_` prefix makes leaks easy to grep for and lets us detect mistakes
 * if a token ever ends up somewhere it shouldn't.
 */

const TOKEN_PREFIX = 'wga_';

export interface MintedAgentToken {
  token: string;       // raw token to hand back to the agent — store on its laptop
  tokenHash: string;   // sha256 hex of token — store in workspace_agents.pairing_token_enc
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintAgentToken(): MintedAgentToken {
  const random = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashAgentToken(token) };
}

export interface AgentIdentity {
  agentId: string;
  userId: string;
  workspaceId: string;
}

/**
 * Read Authorization: Bearer <token> from a Request and resolve to the paired
 * agent row. Returns null if missing/unknown — caller decides 401 shape.
 */
export async function verifyAgentRequest(req: Request): Promise<AgentIdentity | null> {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return null;
  const token = m[1].trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  await ensureSchemaAsync();
  const tokenHash = hashAgentToken(token);
  const row = await getLibsqlDb()
    .prepare(
      `SELECT agent_id, user_id, workspace_id
       FROM workspace_agents
       WHERE pairing_token_enc = ?
       LIMIT 1`,
    )
    .get<{ agent_id: string; user_id: string; workspace_id: string }>(tokenHash);
  if (!row) return null;
  return { agentId: row.agent_id, userId: row.user_id, workspaceId: row.workspace_id };
}

/**
 * Generate a short, human-typeable user code for the device-pair flow.
 * Crockford-base32 alphabet (no I/L/O/U) keeps things unambiguous on
 * print/voice. 8 chars = ~40 bits of entropy, which is fine for a
 * code that expires in 10 minutes and rate-limits on /pair/poll.
 */
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function mintUserCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return out;
}

export function hashUserCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

export const PAIRING_TTL_SECONDS = 10 * 60; // 10 min — device-code style
