import { randomBytes, createHash } from 'crypto';
import { getDb } from '../db';
import { initSchema } from '../schema';

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

export function saveFlowState(input: Omit<OAuthFlowState, 'createdAt'>): void {
  initSchema();
  const db = getDb();
  // Store created_at as ISO-8601 with explicit UTC marker so JavaScript's
  // Date.parse never reinterprets it as local time. The bare default
  // datetime('now') value (UTC text without a 'Z') was being parsed as
  // local time on machines outside UTC, making states look hours old
  // and expire immediately.
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - STATE_TTL_MS).toISOString();
  const gc = db.prepare("DELETE FROM oauth_state WHERE created_at < ?").run(cutoff);

  db.prepare(`
    INSERT INTO oauth_state (state, workspace_id, source, slot, code_verifier, return_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.state, input.workspaceId, input.source, input.slot, input.codeVerifier, input.returnTo ?? null, nowIso);

  console.error(`[oauth state] saved state=${input.state.slice(0, 12)}… for ${input.source}/${input.workspaceId} at ${nowIso} (gc'd ${gc.changes} expired rows)`);
}

export interface StateLookupContext {
  state: string;
  found: boolean;
  expired: boolean;
  recentlyConsumed?: number;
  liveStateCount?: number;
  source?: string;
}

export function consumeFlowState(state: string): OAuthFlowState | null {
  initSchema();
  const db = getDb();
  const row = db.prepare(`
    SELECT state, workspace_id, source, slot, code_verifier, return_to, created_at
    FROM oauth_state WHERE state = ?
  `).get(state) as any;

  if (!row) {
    const liveCount = (db.prepare('SELECT COUNT(*) AS n FROM oauth_state').get() as { n: number }).n;
    console.error(`[oauth state] LOOKUP MISS for state=${state.slice(0, 12)}… (currently ${liveCount} live state rows in DB)`);
    return null;
  }

  db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);

  // Be defensive about timestamp parsing. ISO with 'Z' is unambiguous;
  // legacy SQLite-default 'YYYY-MM-DD HH:MM:SS' (no TZ) is treated as UTC
  // by appending 'Z'. Otherwise local-time parsing makes things look stale.
  const createdRaw = String(row.created_at);
  const normalized = createdRaw.includes('T') || createdRaw.endsWith('Z')
    ? createdRaw
    : createdRaw.replace(' ', 'T') + 'Z';
  const age = Date.now() - new Date(normalized).getTime();
  if (age > STATE_TTL_MS) {
    console.error(`[oauth state] EXPIRED state=${state.slice(0, 12)}… (age=${Math.round(age / 1000)}s, ttl=${STATE_TTL_MS / 1000}s)`);
    return null;
  }

  console.error(`[oauth state] CONSUMED state=${state.slice(0, 12)}… for ${row.source}/${row.workspace_id} (age=${Math.round(age / 1000)}s)`);

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

/** Diagnostic: how many in-flight states currently exist? */
export function liveStateCount(source?: string): number {
  initSchema();
  const db = getDb();
  if (source) {
    return (db.prepare('SELECT COUNT(*) AS n FROM oauth_state WHERE source = ?').get(source) as { n: number }).n;
  }
  return (db.prepare('SELECT COUNT(*) AS n FROM oauth_state').get() as { n: number }).n;
}
