import { NextResponse } from 'next/server';
import { listAvailableBackends } from '@/lib/ai/cli-backends';
import { getActiveWorkspaceId } from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';

export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  const backends = await listAvailableBackends(workspaceId);
  return NextResponse.json({ backends });
}
