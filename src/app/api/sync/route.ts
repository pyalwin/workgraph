import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { computeAllMetrics } from '@/lib/metrics';
import { reclassifyAll } from '@/lib/classify';

export async function POST() {
  try {
    initSchema();
    // TODO: Run actual sync adapters here
    reclassifyAll();
    computeAllMetrics();
    return NextResponse.json({ ok: true, message: 'Sync complete' });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
