import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { listDecisions } from '@/lib/decision/extract';

export const dynamic = 'force-dynamic';

export async function GET() {
  initSchema();
  const decisions = listDecisions().map(d => ({
    ...d,
    summary: d.summary ? JSON.parse(d.summary) : null,
  }));
  return NextResponse.json({ decisions });
}
