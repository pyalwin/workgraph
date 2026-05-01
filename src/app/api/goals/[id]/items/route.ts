import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';

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
    initSchema();
    const { id } = await params;
    const db = getDb();

    const items = db
      .prepare(
        `
      SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title,
             wi.author, wi.status, wi.priority,
             wi.created_at, wi.updated_at
      FROM work_items wi
      JOIN item_tags it ON it.item_id = wi.id
      WHERE it.tag_id = ?
      ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC
      LIMIT 500
    `,
      )
      .all(id) as ItemRow[];

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
