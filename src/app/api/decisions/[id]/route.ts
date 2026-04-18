import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getDb } from '@/lib/db';
import { getDecisionItems, listDecisions } from '@/lib/decision/extract';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initSchema();
  const { id } = await params;
  const d = listDecisions().find(x => x.id === id);
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const items = getDecisionItems(id);
  return NextResponse.json({
    decision: {
      ...d,
      summary: d.summary ? JSON.parse(d.summary) : null,
    },
    items,
  });
}
