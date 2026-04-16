import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema, seedGoals } from '@/lib/schema';
import { v4 as uuid } from 'uuid';

export async function GET() {
  initSchema();
  seedGoals();
  const db = getDb();
  const goals = db.prepare("SELECT * FROM goals WHERE status IN ('active', 'suggested') ORDER BY sort_order").all();
  return NextResponse.json(goals);
}

export async function POST(req: Request) {
  const body = await req.json();
  const db = getDb();
  const id = body.id || uuid();
  db.prepare('INSERT INTO goals (id, name, description, keywords, status, origin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, body.name, body.description || '', JSON.stringify(body.keywords || []), body.status || 'active', body.origin || 'manual', body.sort_order || 99
  );
  return NextResponse.json({ ok: true, id });
}
