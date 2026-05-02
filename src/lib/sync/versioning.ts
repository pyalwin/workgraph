import { v4 as uuid } from 'uuid';
import { getLibsqlDb } from '../db/libsql';

const TRACKED_FIELDS = ['title', 'body', 'status', 'priority', 'author', 'url', 'metadata'] as const;

interface ExistingItem {
  id: string;
  title: string;
  body: string | null;
  status: string | null;
  priority: string | null;
  author: string | null;
  url: string | null;
  metadata: string | null;
}

export function diffFields(
  existing: ExistingItem,
  incoming: {
    title: string;
    body: string | null;
    status: string | null;
    priority: string | null;
    author: string | null;
    url: string | null;
    metadata: string | null;
  },
): Record<string, { old: string | null; new: string | null }> | null {
  const changes: Record<string, { old: string | null; new: string | null }> = {};

  for (const field of TRACKED_FIELDS) {
    const oldVal = existing[field] ?? null;
    const newVal = incoming[field] ?? null;
    if (oldVal !== newVal) {
      changes[field] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

export async function createVersionRecord(
  itemId: string,
  changes: Record<string, { old: string | null; new: string | null }>,
  existing: ExistingItem,
): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT INTO work_item_versions (id, item_id, changed_fields, snapshot, changed_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(uuid(), itemId, JSON.stringify(changes), JSON.stringify(existing));
}
