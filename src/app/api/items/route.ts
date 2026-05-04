import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

const ALLOWED_TYPES = new Set(['note', 'task', 'idea']);

export async function GET(req: NextRequest) {
  await ensureSchemaAsync();
  const sourceId = req.nextUrl.searchParams.get('source_id');
  if (!sourceId) return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  const db = getLibsqlDb();
  const row = await db
    .prepare('SELECT id FROM work_items WHERE source_id = ? LIMIT 1')
    .get<{ id: string }>(sourceId);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ id: row.id });
}

export async function POST(req: NextRequest) {
  await ensureSchemaAsync();
  const body = await req.json().catch(() => null) as { title?: string; body?: string; item_type?: string } | null;
  if (!body?.title || !body.title.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const itemType = body.item_type && ALLOWED_TYPES.has(body.item_type) ? body.item_type : 'note';
  const id = uuid();
  const now = new Date().toISOString();
  const sourceId = `${itemType}-${id.slice(0, 8)}`;

  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT INTO work_items (id, source, source_id, item_type, title, body, status, created_at, updated_at, synced_at)
       VALUES (?, 'manual', ?, ?, ?, ?, 'open', ?, ?, datetime('now'))`,
    )
    .run(id, sourceId, itemType, body.title.trim(), body.body?.trim() || null, now, now);

  return NextResponse.json({ id, source: 'manual', source_id: sourceId, item_type: itemType, title: body.title.trim() });
}
