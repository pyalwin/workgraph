import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { deleteWorkspaceConfig, listWorkspaceConfigs, seedWorkspaceConfig, setWorkspaceEnabled } from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureSchemaAsync();
    await seedWorkspaceConfig();
    const { id: workspaceId } = await params;
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
    await deleteWorkspaceConfig(workspaceId);
    const workspaces = await listWorkspaceConfigs();
    return NextResponse.json({
      ok: true,
      workspaces,
      setupComplete: workspaces.some((workspace) => workspace.enabled !== false),
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
