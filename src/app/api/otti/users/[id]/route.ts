import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getUserMetrics } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest, { params }: { params: { id: string } }) {
  initSchema();

  const period = req.nextUrl.searchParams.get('period') || '7d';
  const metrics = getUserMetrics(params.id, period);
  return NextResponse.json(metrics);
}
