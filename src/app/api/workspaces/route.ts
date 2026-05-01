import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import {
  createWorkspaceConfig,
  listWorkspaceConfigs,
  seedWorkspaceConfig,
} from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    initSchema();
    seedWorkspaceConfig();
    const workspaces = listWorkspaceConfigs();
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
    initSchema();
    seedWorkspaceConfig();
    const body = await req.json();
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'Workspace name is required' }, { status: 400 });

    const workspace = createWorkspaceConfig({
      name,
      preset: body.preset || 'custom-workspace',
      modules: body.modules,
    });
    return NextResponse.json({ ok: true, workspace });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
