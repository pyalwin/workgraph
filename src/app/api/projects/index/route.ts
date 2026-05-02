import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getProjectSummaryCards } from '@/lib/project-queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ensureSchemaAsync();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  return NextResponse.json(await getProjectSummaryCards(period));
}
