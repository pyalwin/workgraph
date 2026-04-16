import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getOttiUserList } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET() {
  initSchema();
  return NextResponse.json(getOttiUserList());
}
