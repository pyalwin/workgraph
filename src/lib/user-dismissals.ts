import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

/**
 * Per-user dismissal record for nudges, banners, hints. Keyed by an opaque
 * string so we don't need a schema migration to add a new banner. Once a
 * (user_id, key) pair is recorded, the corresponding UI surface should hide
 * itself permanently for that user.
 */

export interface DismissalRow {
  key: string;
  dismissedAt: string;
}

let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function listDismissals(userId: string): Promise<DismissalRow[]> {
  await ensureInit();
  const rows = await getLibsqlDb()
    .prepare('SELECT key, dismissed_at FROM user_dismissals WHERE user_id = ? ORDER BY dismissed_at DESC')
    .all<{ key: string; dismissed_at: string }>(userId);
  return rows.map((r) => ({ key: r.key, dismissedAt: r.dismissed_at }));
}

export async function isDismissed(userId: string, key: string): Promise<boolean> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT 1 as ok FROM user_dismissals WHERE user_id = ? AND key = ? LIMIT 1')
    .get<{ ok: number }>(userId, key);
  return !!row;
}

export async function dismiss(userId: string, key: string): Promise<void> {
  await ensureInit();
  await getLibsqlDb()
    .prepare(
      `INSERT INTO user_dismissals (user_id, key, dismissed_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
    )
    .run(userId, key);
}

export async function undismiss(userId: string, key: string): Promise<void> {
  await ensureInit();
  await getLibsqlDb().prepare('DELETE FROM user_dismissals WHERE user_id = ? AND key = ?').run(userId, key);
}
