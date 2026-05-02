import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

interface ItemRow {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  author: string | null;
  status: string | null;
  priority: string | null;
  created_at: string;
  updated_at: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureSchemaAsync();
    const { id } = await params;
    const db = getLibsqlDb();

    const items = await db
      .prepare(
        `SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title,
                wi.author, wi.status, wi.priority,
                wi.created_at, wi.updated_at
         FROM work_items wi
         JOIN item_tags it ON it.item_id = wi.id
         WHERE it.tag_id = ?
         ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC
         LIMIT 500`,
      )
      .all<ItemRow>(id);

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
