import { NextResponse } from 'next/server';
import { listAvailableBackends } from '@/lib/ai/cli-backends';

export const dynamic = 'force-dynamic';

export async function GET() {
  const backends = await listAvailableBackends();
  return NextResponse.json({ backends });
}
