import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getWorkspaceConfig, seedWorkspaceConfig } from '@/lib/workspace-config';

export async function GET() {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();
    const db = getLibsqlDb();

    const row = await db
      .prepare("SELECT config FROM sync_config WHERE id = 'default'")
      .get<{ config: string }>();
    const config = row ? JSON.parse(row.config) : {};

    // Also return goals for the goals management section
    const goals = await db
      .prepare(
        'SELECT id, name, description, keywords, status, sort_order FROM goals ORDER BY sort_order',
      )
      .all();

    return NextResponse.json({ config, goals, workspaceConfig: await getWorkspaceConfig() });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const body = await req.json();

    if (body.config) {
      await db
        .prepare("UPDATE sync_config SET config = ?, updated_at = datetime('now') WHERE id = 'default'")
        .run(JSON.stringify(body.config));
    }

    if (body.workspaceConfig) {
      await db
        .prepare(
          `INSERT INTO workspace_config (id, config, updated_at)
           VALUES ('default', ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = datetime('now')`,
        )
        .run(JSON.stringify(body.workspaceConfig));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
