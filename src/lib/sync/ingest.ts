import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { diffFields, createVersionRecord } from './versioning';
import type { WorkItemInput, SyncResult } from './types';

export interface LinkRowInput {
  from: { source: string; source_id: string };
  to: { source: string; source_id: string };
  link_type: string;
  confidence?: number;
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

/**
 * Resolve (source, source_id) pairs to work_items.id and insert into the links
 * table. Idempotent — uses a deterministic id, INSERT OR IGNORE on collision.
 */
export async function ingestLinks(
  links: LinkRowInput[],
): Promise<{ inserted: number; skipped: number }> {
  await ensureInit();
  const db = getLibsqlDb();

  let inserted = 0;
  let skipped = 0;

  for (const l of links) {
    const src = await db
      .prepare('SELECT id FROM work_items WHERE source = ? AND source_id = ?')
      .get<{ id: string }>(l.from.source, l.from.source_id);
    const tgt = await db
      .prepare('SELECT id FROM work_items WHERE source = ? AND source_id = ?')
      .get<{ id: string }>(l.to.source, l.to.source_id);
    if (!src || !tgt || src.id === tgt.id) {
      skipped++;
      continue;
    }
    const linkId = `${src.id}::${l.link_type}::${tgt.id}`;
    const r = await db
      .prepare(
        'INSERT OR IGNORE INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)',
      )
      .run(linkId, src.id, tgt.id, l.link_type, l.confidence ?? 1.0);
    if (r.changes > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

export async function ingestItems(items: WorkItemInput[]): Promise<SyncResult> {
  await ensureInit();
  const db = getLibsqlDb();

  const result: SyncResult = {
    source: items[0]?.source || 'unknown',
    itemsSynced: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    errors: [],
  };

  for (const item of items) {
    try {
      const existing = (await db
        .prepare(
          'SELECT id, title, body, status, priority, author, url, metadata FROM work_items WHERE source = ? AND source_id = ?',
        )
        .get(item.source, item.source_id)) as
        | {
            id: string;
            title: string;
            body: string | null;
            status: string | null;
            priority: string | null;
            author: string | null;
            url: string | null;
            metadata: string | null;
          }
        | undefined;
      const metadataStr = item.metadata ? JSON.stringify(item.metadata) : null;

      if (!existing) {
        await db
          .prepare(
            `INSERT INTO work_items (id, source, source_id, item_type, title, body, author, status, priority, url, metadata, created_at, updated_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(
            uuid(),
            item.source,
            item.source_id,
            item.item_type,
            item.title,
            item.body,
            item.author,
            item.status,
            item.priority,
            item.url,
            metadataStr,
            item.created_at,
            item.updated_at,
          );
        result.itemsSynced++;
      } else {
        const incoming = {
          title: item.title,
          body: item.body,
          status: item.status,
          priority: item.priority,
          author: item.author,
          url: item.url,
          metadata: metadataStr,
        };
        const changes = diffFields(existing, incoming);

        if (changes) {
          await createVersionRecord(existing.id, changes, existing);
          await db
            .prepare(
              `UPDATE work_items SET title = ?, body = ?, author = ?, status = ?, priority = ?, url = ?, metadata = ?, updated_at = ?, synced_at = datetime('now')
               WHERE source = ? AND source_id = ?`,
            )
            .run(
              item.title,
              item.body,
              item.author,
              item.status,
              item.priority,
              item.url,
              metadataStr,
              item.updated_at,
              item.source,
              item.source_id,
            );
          result.itemsUpdated++;
        } else {
          await db
            .prepare(
              "UPDATE work_items SET synced_at = datetime('now') WHERE source = ? AND source_id = ?",
            )
            .run(item.source, item.source_id);
          result.itemsSkipped++;
        }
      }
    } catch (err: any) {
      result.errors.push(`${item.source_id}: ${err.message}`);
    }
  }

  return result;
}
