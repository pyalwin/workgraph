import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

/**
 * Tiny app-wide key-value store. Use sparingly — one row per setting, no
 * per-user/per-workspace scoping. Keys must be namespaced (`ai.active_provider`)
 * to keep this from devolving into a junk drawer.
 *
 * Async libSQL path. A small in-memory cache backs `getSettingCached` for
 * sync callers (e.g. `getActiveProviderId()` inside `getModel(task)`) — values
 * read once after process boot, refreshed on every successful `setSetting`.
 * First request after boot may see a stale default; that's an acceptable
 * trade-off for keeping `getModel` sync across hundreds of call sites.
 */

const cache = new Map<string, string | null>();
let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function getSetting(key: string): Promise<string | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get<{ value: string | null }>(key);
  const value = row?.value ?? null;
  cache.set(key, value);
  return value;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  await ensureInit();
  if (value === null || value === '') {
    await getLibsqlDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    cache.set(key, null);
    return;
  }
  await getLibsqlDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value);
  cache.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  await setSetting(key, null);
}

/**
 * Sync getter for the few callers that can't go async (e.g. inside the
 * AI middleware factory). Returns the last value read or written through
 * the async path, or null if it's never been touched. Triggers an
 * async refresh in the background so the next caller sees the right value.
 */
export function getSettingCached(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  // Fire-and-forget refresh; first call returns null, subsequent calls are correct.
  void getSetting(key).catch(() => {
    // Surface DB errors via the async path; don't crash the sync caller.
  });
  return null;
}

/** Test helper. */
export function _resetSettingsCacheForTests() {
  cache.clear();
  _initPromise = null;
}
