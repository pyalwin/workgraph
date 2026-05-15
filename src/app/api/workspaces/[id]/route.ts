import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import {
  deleteWorkspaceConfig,
  getWorkspaceOwner,
  listWorkspaceConfigsForUser,
  seedWorkspaceConfig,
  setWorkspaceEnabled,
} from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

/**
 * Authorizes the current user against a workspace id. Returns null when
 * the request should proceed; otherwise returns the NextResponse to
 * short-circuit with.
 */
async function authorize(workspaceId: string): Promise<{ userId: string } | NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const owner = await getWorkspaceOwner(workspaceId);
  // Allow owner-matched workspaces and unclaimed legacy rows. Anything
  // else is a cross-user access attempt.
  if (owner !== null && owner !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { userId: user.id };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();
    const { id: workspaceId } = await params;

    const auth = await authorize(workspaceId);
    if (auth instanceof NextResponse) return auth;

    const body = await req.json();
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
    if (enabled === undefined) {
      return NextResponse.json({ ok: false, error: 'enabled field is required' }, { status: 400 });
    }

    const workspace = await setWorkspaceEnabled(workspaceId, enabled);
    return NextResponse.json({ ok: true, workspace });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();
    const { id: workspaceId } = await params;

    const auth = await authorize(workspaceId);
    if (auth instanceof NextResponse) return auth;

    await deleteWorkspaceConfig(workspaceId);
    const workspaces = await listWorkspaceConfigsForUser(auth.userId);
    return NextResponse.json({
      ok: true,
      workspaces,
      setupComplete: workspaces.some((workspace) => workspace.enabled !== false),
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
