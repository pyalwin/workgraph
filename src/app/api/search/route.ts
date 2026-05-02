import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { searchChunks } from '@/lib/embeddings/embed';

export const dynamic = 'force-dynamic';

interface SearchResult {
  id: string;
  title: string;
  source: string;
  item_type: string;
  trace_role: string | null;
  substance: string | null;
  url: string | null;
  created_at: string;
  match_excerpt: string;
  match_chunk_type: string;
  distance: number;
  workstream_ids: string[];
}

export async function GET(req: NextRequest) {
  await ensureSchemaAsync();
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  const k = Math.min(Math.max(parseInt(searchParams.get('k') || '30', 10), 1), 100);

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [], query: q || '' });
  }

  try {
    const hits = await searchChunks(q, k);

    // Best-score chunk per item
    const bestByItem = new Map<string, typeof hits[0]>();
    for (const h of hits) {
      const prev = bestByItem.get(h.item_id);
      if (!prev || h.distance < prev.distance) bestByItem.set(h.item_id, h);
    }

    const db = getLibsqlDb();
    const itemSql = `SELECT id, title, source, item_type, trace_role, substance, url, created_at
      FROM work_items WHERE id = ?`;
    const wsSql = `SELECT workstream_id FROM workstream_items WHERE item_id = ?`;

    const results: SearchResult[] = [];
    for (const [itemId, hit] of bestByItem) {
      const item = await db.prepare(itemSql).get<any>(itemId);
      if (!item) continue;
      const wss = await db.prepare(wsSql).all<{ workstream_id: string }>(itemId);
      results.push({
        ...item,
        match_excerpt: hit.chunk_text.length > 320 ? hit.chunk_text.slice(0, 320) + '…' : hit.chunk_text,
        match_chunk_type: hit.chunk_type,
        distance: hit.distance,
        workstream_ids: wss.map(w => w.workstream_id),
      });
    }

    results.sort((a, b) => a.distance - b.distance);
    return NextResponse.json({
      query: q,
      total_chunks: hits.length,
      total_items: results.length,
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
