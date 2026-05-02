import { decrypt, encrypt } from '../crypto';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

/**
 * Encrypted provider configurations (Vercel AI Gateway, OpenRouter, ...).
 *
 * Async libSQL path. A small in-memory cache backs `getProviderConfigCached`
 * for sync callers (specifically `getModel(task)` in src/lib/ai/index.ts).
 * Cache populates on first async read and refreshes on every successful
 * upsert/delete. The very first AI call after process boot may use null
 * config and fall through to env-var resolution; that's acceptable since
 * env is the documented fallback path anyway.
 */

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

const cache = new Map<string, ProviderConfig | null>();
let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

function rowToConfig(row: Row | undefined): ProviderConfig | null {
  if (!row) return null;
  return {
    providerId: row.provider_id,
    apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : null,
    baseUrl: row.base_url,
    hasKey: !!row.api_key_enc,
    updatedAt: row.updated_at,
  };
}

export async function getProviderConfig(providerId: string): Promise<ProviderConfig | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT provider_id, api_key_enc, base_url, updated_at FROM ai_provider_configs WHERE provider_id = ?')
    .get<Row>(providerId);
  const cfg = rowToConfig(row);
  cache.set(providerId, cfg);
  return cfg;
}

/**
 * Sync getter for the few callers that can't go async (specifically
 * getModel(task) in src/lib/ai/index.ts). Returns the last value read or
 * written through the async path, or null if it's never been touched.
 * Triggers a background refresh so the next caller sees the right value.
 */
export function getProviderConfigCached(providerId: string): ProviderConfig | null {
  if (cache.has(providerId)) return cache.get(providerId) ?? null;
  void getProviderConfig(providerId).catch(() => {
    // surface DB errors via the async path; don't crash the sync caller
  });
  return null;
}

export async function listProviderConfigSummaries(): Promise<ProviderConfigSummary[]> {
  await ensureInit();
  const rows = await getLibsqlDb()
    .prepare('SELECT provider_id, api_key_enc, base_url, updated_at FROM ai_provider_configs ORDER BY provider_id')
    .all<Row>();
  return rows.map((r) => ({
    providerId: r.provider_id,
    hasKey: !!r.api_key_enc,
    baseUrl: r.base_url,
    updatedAt: r.updated_at,
  }));
}

export async function upsertProviderConfig(providerId: string, input: ProviderConfigInput): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();

  const existing = await db
    .prepare('SELECT api_key_enc, base_url FROM ai_provider_configs WHERE provider_id = ?')
    .get<{ api_key_enc: string | null; base_url: string | null }>(providerId);

  let apiKeyEnc: string | null = existing?.api_key_enc ?? null;
  if (input.apiKey === null || input.apiKey === '') apiKeyEnc = null;
  else if (typeof input.apiKey === 'string') apiKeyEnc = encrypt(input.apiKey);

  let baseUrl: string | null = existing?.base_url ?? null;
  if (input.baseUrl === null || input.baseUrl === '') baseUrl = null;
  else if (typeof input.baseUrl === 'string') baseUrl = input.baseUrl;

  await db
    .prepare(
      `INSERT INTO ai_provider_configs (provider_id, api_key_enc, base_url, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         api_key_enc = excluded.api_key_enc,
         base_url = excluded.base_url,
         updated_at = excluded.updated_at`,
    )
    .run(providerId, apiKeyEnc, baseUrl);

  // Refresh cache from the row we just wrote so getProviderConfigCached is
  // consistent for the next sync caller.
  cache.set(providerId, {
    providerId,
    apiKey: apiKeyEnc ? decrypt(apiKeyEnc) : null,
    baseUrl,
    hasKey: !!apiKeyEnc,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteProviderConfig(providerId: string): Promise<void> {
  await ensureInit();
  await getLibsqlDb().prepare('DELETE FROM ai_provider_configs WHERE provider_id = ?').run(providerId);
  cache.set(providerId, null);
}

/** Test helper. */
export function _resetProviderConfigCacheForTests() {
  cache.clear();
  _initPromise = null;
}
