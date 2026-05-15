import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getActiveWorkspaceId } from '@/lib/active-workspace';
import { v4 as uuid } from 'uuid';

export async function GET() {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const workspaceId = await getActiveWorkspaceId();
  const goals = await db
    .prepare(
      "SELECT * FROM goals WHERE workspace_id = ? AND status IN ('active', 'suggested') ORDER BY sort_order",
    )
    .all(workspaceId);
  return NextResponse.json(goals);
}

export async function POST(req: Request) {
  await ensureSchemaAsync();
  const body = await req.json();
  const db = getLibsqlDb();
  const workspaceId = await getActiveWorkspaceId();
  const id = body.id || uuid();
  await db
    .prepare(
      'INSERT INTO goals (id, name, description, keywords, status, origin, sort_order, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      body.name,
      body.description || '',
      JSON.stringify(body.keywords || []),
      body.status || 'active',
      body.origin || 'manual',
      body.sort_order || 99,
      workspaceId,
    );
  return NextResponse.json({ ok: true, id });
}
