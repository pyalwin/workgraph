import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema, seedGoals, seedConfig } from '@/lib/schema';

export async function GET() {
  try {
    initSchema();
    seedGoals();
    seedConfig();
    const db = getDb();

    const row = db.prepare("SELECT config FROM sync_config WHERE id = 'default'").get() as { config: string } | undefined;
    const config = row ? JSON.parse(row.config) : {};

    // Also return goals for the goals management section
    const goals = db.prepare("SELECT id, name, description, keywords, status, sort_order FROM goals ORDER BY sort_order").all();

    return NextResponse.json({ config, goals });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    initSchema();
    const db = getDb();
    const body = await req.json();

    if (body.config) {
      db.prepare("UPDATE sync_config SET config = ?, updated_at = datetime('now') WHERE id = 'default'").run(JSON.stringify(body.config));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
