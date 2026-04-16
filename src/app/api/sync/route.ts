import { NextResponse } from 'next/server';
import { initSchema, seedGoals } from '@/lib/schema';
import { computeAllMetrics } from '@/lib/metrics';
import { reclassifyAll } from '@/lib/classify';
import { createLinksForAll } from '@/lib/crossref';
import { getDb } from '@/lib/db';

export async function POST() {
  try {
    initSchema();
    seedGoals();
    reclassifyAll();
    createLinksForAll();
    computeAllMetrics();

    const db = getDb();
    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    return NextResponse.json({ ok: true, message: 'Processing complete', totalItems, totalLinks });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    initSchema();
    const db = getDb();
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const status: Record<string, any> = {};

    for (const source of sources) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(source) as any)?.c || 0;
      const lastSync = db.prepare("SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1").get(source) as any;
      status[source] = { count, lastSync: lastSync?.completed_at || null };
    }

    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalVersions = (db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    return NextResponse.json({ totalItems, totalVersions, totalLinks, sources: status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
