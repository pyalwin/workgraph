import { v4 as uuid } from 'uuid';
import { decryptOptional, encrypt, encryptOptional, isCryptoConfigured } from '../crypto';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

export interface OAuthTokenInput {
  workspaceId: string;
  source: string;
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  scope?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface OAuthToken {
  id: string;
  workspaceId: string;
  source: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface OAuthTokenRow {
  id: string;
  workspace_id: string;
  source: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  metadata_enc: string | null;
  token_type: string;
  scope: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

function rowToToken(row: OAuthTokenRow): OAuthToken {
  const md = decryptOptional(row.metadata_enc);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    accessToken: decryptOptional(row.access_token_enc) || '',
    refreshToken: decryptOptional(row.refresh_token_enc),
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at,
    metadata: md ? JSON.parse(md) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveOAuthToken(input: OAuthTokenInput): Promise<OAuthToken> {
  if (!isCryptoConfigured()) {
    throw new Error(
      'Cannot save OAuth tokens — WORKGRAPH_SECRET_KEY is not set. ' +
        'Run `bunx tsx scripts/gen-secret.ts` to generate one.',
    );
  }
  await ensureInit();
  const db = getLibsqlDb();
  const now = new Date().toISOString();

  const existing = await db
    .prepare('SELECT id, created_at FROM oauth_tokens WHERE workspace_id = ? AND source = ?')
    .get<{ id: string; created_at: string }>(input.workspaceId, input.source);

  const id = existing?.id ?? uuid();
  const accessEnc = encrypt(input.accessToken);
  const refreshEnc = encryptOptional(input.refreshToken);
  const metadataEnc = input.metadata ? encrypt(JSON.stringify(input.metadata)) : null;

  if (existing) {
    await db
      .prepare(
        `UPDATE oauth_tokens
         SET access_token_enc = ?, refresh_token_enc = ?, metadata_enc = ?,
             token_type = ?, scope = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        accessEnc,
        refreshEnc,
        metadataEnc,
        input.tokenType || 'Bearer',
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        id,
      );
  } else {
    await db
      .prepare(
        `INSERT INTO oauth_tokens
           (id, workspace_id, source, access_token_enc, refresh_token_enc, metadata_enc,
            token_type, scope, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.source,
        accessEnc,
        refreshEnc,
        metadataEnc,
        input.tokenType || 'Bearer',
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
      );
  }

  const saved = await getOAuthToken(input.workspaceId, input.source);
  if (!saved) throw new Error('saveOAuthToken: row vanished after upsert');
  return saved;
}

export async function getOAuthToken(workspaceId: string, source: string): Promise<OAuthToken | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT * FROM oauth_tokens WHERE workspace_id = ? AND source = ?')
    .get<OAuthTokenRow>(workspaceId, source);
  return row ? rowToToken(row) : null;
}

export async function deleteOAuthToken(workspaceId: string, source: string): Promise<boolean> {
  await ensureInit();
  const r = await getLibsqlDb()
    .prepare('DELETE FROM oauth_tokens WHERE workspace_id = ? AND source = ?')
    .run(workspaceId, source);
  return r.changes > 0;
}

export async function rotateOAuthToken(
  workspaceId: string,
  source: string,
  next: { accessToken: string; refreshToken?: string | null; expiresAt?: string | null },
): Promise<OAuthToken | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const now = new Date().toISOString();
  const r = await db
    .prepare(
      `UPDATE oauth_tokens
       SET access_token_enc = ?,
           refresh_token_enc = COALESCE(?, refresh_token_enc),
           expires_at = COALESCE(?, expires_at),
           updated_at = ?
       WHERE workspace_id = ? AND source = ?`,
    )
    .run(
      encrypt(next.accessToken),
      next.refreshToken !== undefined ? encryptOptional(next.refreshToken) : null,
      next.expiresAt ?? null,
      now,
      workspaceId,
      source,
    );
  if (r.changes === 0) return null;
  return getOAuthToken(workspaceId, source);
}

export function isExpired(token: OAuthToken, leewaySeconds = 60): boolean {
  if (!token.expiresAt) return false;
  const expiry = new Date(token.expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;
  return Date.now() + leewaySeconds * 1000 >= expiry;
}
