import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getDecisionItems, listDecisions } from '@/lib/decision/extract';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureSchemaAsync();
  const { id } = await params;
  const list = await listDecisions();
  const d = list.find(x => x.id === id);
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const items = await getDecisionItems(id);
  return NextResponse.json({
    decision: {
      ...d,
      summary: d.summary ? JSON.parse(d.summary) : null,
    },
    items,
  });
}
