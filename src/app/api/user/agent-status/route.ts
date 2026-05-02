import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { getAgentStatusForUser } from '@/lib/workspace-agents';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await getAgentStatusForUser(user.id));
}
