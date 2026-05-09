import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import {
  deleteBacklogItem,
  isBacklogKind,
  isBacklogState,
  updateBacklogItem,
} from '@/lib/project-backlog';

export const dynamic = 'force-dynamic';

interface PatchBody {
  state?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ key: string; id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const params = await props.params;
  const workspaceId = await resolveAlmanacWorkspaceId(params.key);

  const patch: Parameters<typeof updateBacklogItem>[2] = {};
  if (body.state !== undefined) {
    if (!isBacklogState(body.state)) return NextResponse.json({ error: 'invalid_state' }, { status: 400 });
    patch.state = body.state;
  }
  if (body.kind !== undefined) {
    if (!isBacklogKind(body.kind)) return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
    patch.kind = body.kind;
  }
  if (typeof body.title === 'string') patch.title = body.title;
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }

  const item = await updateBacklogItem(workspaceId, params.id, patch);
  if (!item) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true, item });
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ key: string; id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const workspaceId = await resolveAlmanacWorkspaceId(params.key);
  const removed = await deleteBacklogItem(workspaceId, params.id);
  if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
