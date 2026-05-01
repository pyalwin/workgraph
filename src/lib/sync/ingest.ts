import { getDb } from '../db';
import { initSchema } from '../schema';
import { v4 as uuid } from 'uuid';
import { diffFields, createVersionRecord } from './versioning';
import type { WorkItemInput, SyncResult } from './types';

export interface LinkRowInput {
  from: { source: string; source_id: string };
  to: { source: string; source_id: string };
  link_type: string;
  confidence?: number;
}

/**
 * Resolve (source, source_id) pairs to work_items.id and insert into the links
 * table. Idempotent — uses a deterministic id, INSERT OR IGNORE on collision.
 */
export function ingestLinks(links: LinkRowInput[]): { inserted: number; skipped: number } {
  initSchema();
  const db = getDb();
  const lookup = db.prepare('SELECT id FROM work_items WHERE source = ? AND source_id = ?');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)',
  );

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const l of links) {
      const src = lookup.get(l.from.source, l.from.source_id) as { id: string } | undefined;
      const tgt = lookup.get(l.to.source, l.to.source_id) as { id: string } | undefined;
      if (!src || !tgt || src.id === tgt.id) { skipped++; continue; }
      const linkId = `${src.id}::${l.link_type}::${tgt.id}`;
      const r = insert.run(linkId, src.id, tgt.id, l.link_type, l.confidence ?? 1.0);
      if (r.changes > 0) inserted++; else skipped++;
    }
  });
  tx();
  return { inserted, skipped };
}

export function ingestItems(items: WorkItemInput[]): SyncResult {
  const db = getDb();
  initSchema();

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
