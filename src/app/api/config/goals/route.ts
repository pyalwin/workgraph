import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getActiveWorkspaceId } from '@/lib/active-workspace';
import { v4 as uuid } from 'uuid';

export async function POST(req: Request) {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const body = await req.json();
    const workspaceId = await getActiveWorkspaceId();

    const id = body.id || uuid();
    // sort_order is computed within the workspace so a new workspace's
    // goals start at 1, not after another workspace's max.
    const maxRow = await db
      .prepare('SELECT MAX(sort_order) as m FROM goals WHERE workspace_id = ?')
      .get<{ m: number | null }>(workspaceId);
    const maxOrder = maxRow?.m ?? 0;

    await db
      .prepare(
        'INSERT INTO goals (id, name, description, keywords, status, origin, sort_order, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        body.name,
        body.description || '',
        JSON.stringify(body.keywords || []),
        'active',
        'manual',
        maxOrder + 1,
        workspaceId,
      );

    return NextResponse.json({ ok: true, id });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const body = await req.json();
    const workspaceId = await getActiveWorkspaceId();

    await db
      .prepare(
        "UPDATE goals SET name = ?, description = ?, keywords = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?",
      )
      .run(
        body.name,
        body.description || '',
        JSON.stringify(body.keywords || []),
        body.status || 'active',
        body.id,
        workspaceId,
      );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const workspaceId = await getActiveWorkspaceId();

    if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

    await db.prepare('DELETE FROM goals WHERE id = ? AND workspace_id = ?').run(id, workspaceId);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
