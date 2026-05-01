import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { initOttiModule } from '@/lib/modules/otti';
import { getOttiDeployments, createOttiDeployment } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET() {
  initSchema();
  initOttiModule();
  return NextResponse.json(getOttiDeployments());
}

export async function POST(req: NextRequest) {
  initSchema();
  initOttiModule();
  const body = await req.json();
  const { name, deploy_date } = body;

  if (!name || !deploy_date) {
    return NextResponse.json({ error: 'name and deploy_date required' }, { status: 400 });
  }

  const result = createOttiDeployment(name, deploy_date);
  return NextResponse.json(result, { status: 201 });
}
