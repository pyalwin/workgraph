import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';
import { v4 as uuid } from 'uuid';

export async function POST(req: Request) {
  try {
    initSchema();
    const db = getDb();
    const body = await req.json();

    const id = body.id || uuid();
    const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM goals').get() as any)?.m || 0;

    db.prepare('INSERT INTO goals (id, name, description, keywords, status, origin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, body.name, body.description || '', JSON.stringify(body.keywords || []), 'active', 'manual', maxOrder + 1
    );

    return NextResponse.json({ ok: true, id });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    initSchema();
    const db = getDb();
    const body = await req.json();

    db.prepare('UPDATE goals SET name = ?, description = ?, keywords = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      body.name, body.description || '', JSON.stringify(body.keywords || []), body.status || 'active', body.id
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    initSchema();
    const db = getDb();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

    db.prepare("DELETE FROM goals WHERE id = ?").run(id);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
