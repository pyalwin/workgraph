import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getUserWorkspaceId } from '@/lib/active-workspace';
import { seedWorkspaceConfig } from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

/**
 * Returns the workspace that the authenticated user owns. Used by the
 * client to keep WorkgraphStateProvider's `state.workspaceId` in sync
 * with the server-resolved single workspace and to drive onboarding /
 * "create another workspace" gating.
 */
export async function GET() {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();

    const { user } = await withAuth();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const workspaceId = await getUserWorkspaceId();
    return NextResponse.json({
      workspaceId,
      hasWorkspace: workspaceId !== null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
