import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { listDecisions } from '@/lib/decision/extract';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureSchemaAsync();
  const list = await listDecisions();
  const decisions = list.map(d => ({
    ...d,
    summary: d.summary ? JSON.parse(d.summary) : null,
  }));
  return NextResponse.json({ decisions });
}
