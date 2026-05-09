import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import {
  createBacklogItem,
  isBacklogKind,
  isBacklogState,
  listBacklog,
  type BacklogKind,
  type BacklogState,
} from '@/lib/project-backlog';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  const stateParam = req.nextUrl.searchParams.get('state');
  const kindParam = req.nextUrl.searchParams.get('kind');

  const items = await listBacklog(workspaceId, projectKey, {
    state: stateParam === 'all' || isBacklogState(stateParam) ? (stateParam as BacklogState | 'all') : undefined,
    kind: kindParam === 'all' || isBacklogKind(kindParam) ? (kindParam as BacklogKind | 'all') : undefined,
  });

  return NextResponse.json({ projectKey, items });
}

interface CreateBody {
  kind?: unknown;
  title?: unknown;
  description?: unknown;
}

export async function POST(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isBacklogKind(body.kind)) {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  try {
    const item = await createBacklogItem({
      workspaceId,
      projectKey,
      kind: body.kind,
      title: body.title,
      description: typeof body.description === 'string' ? body.description : null,
      source: 'manual',
      aiGenerated: false,
    });
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('already exists') ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
