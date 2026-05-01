import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { initOttiModule } from '@/lib/modules/otti';
import { getOttiUserList } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET() {
  initSchema();
  initOttiModule();
  return NextResponse.json(getOttiUserList());
}
