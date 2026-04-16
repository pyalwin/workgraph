import { getDb } from '../db';
import { v4 as uuid } from 'uuid';

export function getLastSyncDate(source: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1"
  ).get(source) as { completed_at: string } | undefined;
  return row?.completed_at || null;
}

export function startSyncLog(source: string): string {
  const db = getDb();
  const id = uuid();
  db.prepare(
    "INSERT INTO sync_log (id, source, started_at, status) VALUES (?, ?, datetime('now'), 'running')"
  ).run(id, source);
  return id;
}

export function completeSyncLog(logId: string, itemsSynced: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE sync_log SET completed_at = datetime('now'), items_synced = ?, status = 'success' WHERE id = ?"
  ).run(itemsSynced, logId);
}

export function failSyncLog(logId: string, error: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE sync_log SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?"
  ).run(error, logId);
}
