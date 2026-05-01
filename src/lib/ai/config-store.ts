import { getDb } from '../db';
import { initSchema } from '../schema';
import { decrypt, encrypt } from '../crypto';

export interface ProviderConfig {
  providerId: string;
  apiKey: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  updatedAt: string | null;
}

export interface ProviderConfigSummary {
  providerId: string;
  hasKey: boolean;
  baseUrl: string | null;
  updatedAt: string | null;
}

export interface ProviderConfigInput {
  /** Plaintext key. `''` or `null` clears it. `undefined` keeps the existing value. */
  apiKey?: string | null;
  /** `''` or `null` clears it. `undefined` keeps the existing value. */
  baseUrl?: string | null;
}

interface Row {
  provider_id: string;
  api_key_enc: string | null;
  base_url: string | null;
  updated_at: string | null;
}

function ensureTable() {
  initSchema();
}

export function getProviderConfig(providerId: string): ProviderConfig | null {
  ensureTable();
  const row = getDb()
    .prepare('SELECT provider_id, api_key_enc, base_url, updated_at FROM ai_provider_configs WHERE provider_id = ?')
    .get(providerId) as Row | undefined;
  if (!row) return null;
  return {
    providerId: row.provider_id,
    apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : null,
    baseUrl: row.base_url,
    hasKey: !!row.api_key_enc,
    updatedAt: row.updated_at,
  };
}

export function listProviderConfigSummaries(): ProviderConfigSummary[] {
  ensureTable();
  const rows = getDb()
    .prepare('SELECT provider_id, api_key_enc, base_url, updated_at FROM ai_provider_configs ORDER BY provider_id')
    .all() as Row[];
  return rows.map((r) => ({
    providerId: r.provider_id,
    hasKey: !!r.api_key_enc,
    baseUrl: r.base_url,
    updatedAt: r.updated_at,
  }));
}

export function upsertProviderConfig(providerId: string, input: ProviderConfigInput): void {
  ensureTable();
  const db = getDb();
  const existing = db
    .prepare('SELECT api_key_enc, base_url FROM ai_provider_configs WHERE provider_id = ?')
    .get(providerId) as { api_key_enc: string | null; base_url: string | null } | undefined;

  let apiKeyEnc: string | null = existing?.api_key_enc ?? null;
  if (input.apiKey === null || input.apiKey === '') apiKeyEnc = null;
  else if (typeof input.apiKey === 'string') apiKeyEnc = encrypt(input.apiKey);

  let baseUrl: string | null = existing?.base_url ?? null;
  if (input.baseUrl === null || input.baseUrl === '') baseUrl = null;
  else if (typeof input.baseUrl === 'string') baseUrl = input.baseUrl;

  db.prepare(`
    INSERT INTO ai_provider_configs (provider_id, api_key_enc, base_url, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(provider_id) DO UPDATE SET
      api_key_enc = excluded.api_key_enc,
      base_url = excluded.base_url,
      updated_at = excluded.updated_at
  `).run(providerId, apiKeyEnc, baseUrl);
}

export function deleteProviderConfig(providerId: string): void {
  ensureTable();
  getDb().prepare('DELETE FROM ai_provider_configs WHERE provider_id = ?').run(providerId);
}
