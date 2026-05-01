import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { initOttiModule } from '@/lib/modules/otti';
import { getUserMetrics } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  initSchema();
  initOttiModule();

  const period = req.nextUrl.searchParams.get('period') || '7d';
  const metrics = getUserMetrics(params.id, period);
  return NextResponse.json(metrics);
}
