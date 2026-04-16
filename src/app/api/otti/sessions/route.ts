import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getOttiMetrics } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  initSchema();

  const params = req.nextUrl.searchParams;
  const period = params.get('period') || '7d';
  const compare = params.get('compare') === 'true';
  const splitDate = params.get('split_date') || null;

  const metrics = getOttiMetrics(period, compare, splitDate);
  return NextResponse.json(metrics);
}
