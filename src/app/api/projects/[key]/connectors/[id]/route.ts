import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import { detachProjectConnector } from '@/lib/project-connectors';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ key: string; id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  const removed = await detachProjectConnector(workspaceId, params.id);
  if (!removed) {
    return NextResponse.json({ error: 'connector_not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
