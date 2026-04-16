import { getDb } from '../db';
import { initSchema, seedGoals } from '../schema';
import { v4 as uuid } from 'uuid';
import { diffFields, createVersionRecord } from './versioning';
import type { WorkItemInput, SyncResult } from './types';

export function ingestItems(items: WorkItemInput[]): SyncResult {
  const db = getDb();
  initSchema();
  seedGoals();

  const result: SyncResult = {
    source: items[0]?.source || 'unknown',
    itemsSynced: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    errors: [],
  };

  const findExisting = db.prepare('SELECT id, title, body, status, priority, author, url, metadata FROM work_items WHERE source = ? AND source_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO work_items (id, source, source_id, item_type, title, body, author, status, priority, url, metadata, created_at, updated_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const updateItem = db.prepare(`
    UPDATE work_items SET title = ?, body = ?, author = ?, status = ?, priority = ?, url = ?, metadata = ?, updated_at = ?, synced_at = datetime('now')
    WHERE source = ? AND source_id = ?
  `);
  const touchItem = db.prepare("UPDATE work_items SET synced_at = datetime('now') WHERE source = ? AND source_id = ?");

  const ingestAll = db.transaction(() => {
    for (const item of items) {
      try {
        const existing = findExisting.get(item.source, item.source_id) as any;
        const metadataStr = item.metadata ? JSON.stringify(item.metadata) : null;

        if (!existing) {
          insertItem.run(uuid(), item.source, item.source_id, item.item_type, item.title, item.body, item.author, item.status, item.priority, item.url, metadataStr, item.created_at, item.updated_at);
          result.itemsSynced++;
        } else {
          const incoming = { title: item.title, body: item.body, status: item.status, priority: item.priority, author: item.author, url: item.url, metadata: metadataStr };
          const changes = diffFields(existing, incoming);

          if (changes) {
            createVersionRecord(existing.id, changes, existing);
            updateItem.run(item.title, item.body, item.author, item.status, item.priority, item.url, metadataStr, item.updated_at, item.source, item.source_id);
            result.itemsUpdated++;
          } else {
            touchItem.run(item.source, item.source_id);
            result.itemsSkipped++;
          }
        }
      } catch (err: any) {
        result.errors.push(`${item.source_id}: ${err.message}`);
      }
    }
  });

  ingestAll();
  return result;
}
