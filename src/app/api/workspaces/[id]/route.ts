import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { deleteWorkspaceConfig, listWorkspaceConfigs, seedWorkspaceConfig, setWorkspaceEnabled } from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initSchema();
    seedWorkspaceConfig();
    const { id: workspaceId } = await params;
    const body = await req.json();
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
    if (enabled === undefined) {
      return NextResponse.json({ ok: false, error: 'enabled field is required' }, { status: 400 });
    }

    const workspace = setWorkspaceEnabled(workspaceId, enabled);
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
    initSchema();
    seedWorkspaceConfig();
    const { id: workspaceId } = await params;
    deleteWorkspaceConfig(workspaceId);
    const workspaces = listWorkspaceConfigs();
    return NextResponse.json({
      ok: true,
      workspaces,
      setupComplete: workspaces.some((workspace) => workspace.enabled !== false),
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
