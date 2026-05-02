import { randomBytes, createHash } from 'crypto';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

export interface OAuthFlowState {
  state: string;
  workspaceId: string;
  source: string;
  slot: string;
  codeVerifier: string;
  returnTo: string | null;
  createdAt: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

export async function saveFlowState(input: Omit<OAuthFlowState, 'createdAt'>): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  // Store created_at as ISO-8601 with explicit UTC marker so JavaScript's
  // Date.parse never reinterprets it as local time. The bare default
  // datetime('now') value (UTC text without a 'Z') was being parsed as
  // local time on machines outside UTC, making states look hours old
  // and expire immediately.
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - STATE_TTL_MS).toISOString();
  const gc = await db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(cutoff);

  await db
    .prepare(
      `INSERT INTO oauth_state (state, workspace_id, source, slot, code_verifier, return_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.state, input.workspaceId, input.source, input.slot, input.codeVerifier, input.returnTo ?? null, nowIso);

  console.error(
    `[oauth state] saved state=${input.state.slice(0, 12)}… for ${input.source}/${input.workspaceId} at ${nowIso} (gc'd ${gc.changes} expired rows)`,
  );
}

export interface StateLookupContext {
  state: string;
  found: boolean;
  expired: boolean;
  recentlyConsumed?: number;
  liveStateCount?: number;
  source?: string;
}

export async function consumeFlowState(state: string): Promise<OAuthFlowState | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT state, workspace_id, source, slot, code_verifier, return_to, created_at
       FROM oauth_state WHERE state = ?`,
    )
    .get<{
      state: string;
      workspace_id: string;
      source: string;
      slot: string;
      code_verifier: string;
      return_to: string | null;
      created_at: string;
    }>(state);

  if (!row) {
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM oauth_state').get<{ n: number }>();
    const liveCount = countRow?.n ?? 0;
    console.error(
      `[oauth state] LOOKUP MISS for state=${state.slice(0, 12)}… (currently ${liveCount} live state rows in DB)`,
    );
    return null;
  }

  await db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);

  // Be defensive about timestamp parsing. ISO with 'Z' is unambiguous;
  // legacy SQLite-default 'YYYY-MM-DD HH:MM:SS' (no TZ) is treated as UTC
  // by appending 'Z'. Otherwise local-time parsing makes things look stale.
  const createdRaw = String(row.created_at);
  const normalized =
    createdRaw.includes('T') || createdRaw.endsWith('Z') ? createdRaw : createdRaw.replace(' ', 'T') + 'Z';
  const age = Date.now() - new Date(normalized).getTime();
  if (age > STATE_TTL_MS) {
    console.error(
      `[oauth state] EXPIRED state=${state.slice(0, 12)}… (age=${Math.round(age / 1000)}s, ttl=${STATE_TTL_MS / 1000}s)`,
    );
    return null;
  }

  console.error(
    `[oauth state] CONSUMED state=${state.slice(0, 12)}… for ${row.source}/${row.workspace_id} (age=${Math.round(age / 1000)}s)`,
  );

  return {
    state: row.state,
    workspaceId: row.workspace_id,
    source: row.source,
    slot: row.slot,
    codeVerifier: row.code_verifier,
    returnTo: row.return_to,
    createdAt: row.created_at,
  };
}

export async function liveStateCount(source?: string): Promise<number> {
  await ensureInit();
  const db = getLibsqlDb();
  const sql = source
    ? 'SELECT COUNT(*) AS n FROM oauth_state WHERE source = ?'
    : 'SELECT COUNT(*) AS n FROM oauth_state';
  const row = source
    ? await db.prepare(sql).get<{ n: number }>(source)
    : await db.prepare(sql).get<{ n: number }>();
  return row?.n ?? 0;
}
