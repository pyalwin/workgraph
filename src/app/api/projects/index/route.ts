import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectSummaryCards } from '@/lib/project-queries';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  initSchema();
  migrateProjectSummaries();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  return NextResponse.json(getProjectSummaryCards(period));
}
