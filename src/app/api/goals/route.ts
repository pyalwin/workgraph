import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { v4 as uuid } from 'uuid';

export async function GET() {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const goals = await db
    .prepare("SELECT * FROM goals WHERE status IN ('active', 'suggested') ORDER BY sort_order")
    .all();
  return NextResponse.json(goals);
}

export async function POST(req: Request) {
  await ensureSchemaAsync();
  const body = await req.json();
  const db = getLibsqlDb();
  const id = body.id || uuid();
  await db
    .prepare(
      'INSERT INTO goals (id, name, description, keywords, status, origin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      body.name,
      body.description || '',
      JSON.stringify(body.keywords || []),
      body.status || 'active',
      body.origin || 'manual',
      body.sort_order || 99,
    );
  return NextResponse.json({ ok: true, id });
}
