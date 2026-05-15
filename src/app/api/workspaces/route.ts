import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getUserWorkspaceId, userHasWorkspace } from '@/lib/active-workspace';
import {
  createWorkspaceConfig,
  listWorkspaceConfigsForUser,
  seedWorkspaceConfig,
} from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();
    const { user } = await withAuth();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Resolving the user's workspace also performs the first-time claim
    // for legacy unclaimed rows; do it before listing so the freshly
    // claimed workspace shows up in the response.
    await getUserWorkspaceId();
    const workspaces = await listWorkspaceConfigsForUser(user.id);
    return NextResponse.json({
      workspaces,
      setupComplete: workspaces.some((workspace) => workspace.enabled !== false),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();

    const { user } = await withAuth();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (await userHasWorkspace()) {
      return NextResponse.json(
        { error: 'You already have a workspace. Delete the existing one first to create a new one.' },
        { status: 409 },
      );
    }

    const body = await req.json();
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'Workspace name is required' }, { status: 400 });

    const workspace = await createWorkspaceConfig({
      name,
      preset: body.preset || 'custom-workspace',
      modules: body.modules,
      authUserId: user.id,
    });
    return NextResponse.json({ ok: true, workspace });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
