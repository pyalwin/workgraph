import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { createLinksForAll } from '@/lib/crossref';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/workspaces/:id/crossref?mode=incremental|full
 *
 *  - incremental (default): re-runs createLinksForItem on items synced in the
 *    last 7 days, plus any item without a single existing link. Cheap, useful
 *    after enabling a new adapter or running a backfill.
 *  - full: nukes 'soft' links (mentions/references/discusses/executes) and
 *    re-runs createLinksForAll over the entire DB. Several minutes for large
 *    workspaces. Structural links (in_repo / in_project / child_of) survive.
 *
 * Returns counts so the UI can show progress.
 */
export async function POST(req: Request) {
  try {
    initSchema();
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'incremental';
    const db = getDb();

    if (mode === 'full') {
      // Soft links only — preserve adapter-emitted structural edges.
      // Use a join because item_links_chunks references links via FK.
      db.exec(`
        DELETE FROM item_links_chunks WHERE link_id IN (
          SELECT id FROM links WHERE link_type IN ('mentions','references','discusses','executes','related_code')
        )
      `);
      const r = db.prepare(
        "DELETE FROM links WHERE link_type IN ('mentions','references','discusses','executes','related_code')",
      ).run();
      console.error(`[crossref full] cleared ${r.changes} soft links`);

      const result = createLinksForAll({});
      return NextResponse.json({ ok: true, mode, ...result });
    }

    // Incremental mode — process items synced recently.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const candidates = db
      .prepare('SELECT id FROM work_items WHERE synced_at >= ? OR enriched_at IS NULL ORDER BY synced_at DESC LIMIT 1000')
      .all(cutoff) as { id: string }[];

    const { createLinksForItem } = await import('@/lib/crossref');
    let totalLinks = 0;
    for (const r of candidates) totalLinks += createLinksForItem(r.id);

    return NextResponse.json({ ok: true, mode, items: candidates.length, links: totalLinks });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
