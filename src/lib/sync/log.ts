import { v4 as uuid } from 'uuid';
import { getLibsqlDb } from '../db/libsql';

export async function getLastSyncDate(source: string): Promise<string | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      "SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1",
    )
    .get<{ completed_at: string }>(source);
  return row?.completed_at || null;
}

export async function startSyncLog(source: string): Promise<string> {
  const db = getLibsqlDb();
  const id = uuid();
  await db
    .prepare("INSERT INTO sync_log (id, source, started_at, status) VALUES (?, ?, datetime('now'), 'running')")
    .run(id, source);
  return id;
}

export async function completeSyncLog(logId: string, itemsSynced: number): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      "UPDATE sync_log SET completed_at = datetime('now'), items_synced = ?, status = 'success' WHERE id = ?",
    )
    .run(itemsSynced, logId);
}

export async function failSyncLog(logId: string, error: string): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare("UPDATE sync_log SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?")
    .run(error, logId);
}
