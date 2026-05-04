/**
 * GET  /api/almanac/units?projectKey=KAN
 *      Returns list of functional units for a project.
 *
 * POST /api/almanac/units
 *      Create a new manual unit.
 *
 * Auth: withAuth() — browser session required.
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { createUnit, listUnits } from '@/lib/almanac/unit-mutations';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();

  const url = new URL(req.url);
  const projectKey = url.searchParams.get('projectKey');
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 });
  }

  // workspaceId is always 'default' in this single-workspace app
  const workspaceId = 'default';
  const units = await listUnits(workspaceId, projectKey);

  return NextResponse.json({ units });
}

interface CreateUnitBody {
  workspaceId?: string;
  projectKey: string;
  name: string;
  description?: string;
  filePathPatterns?: string[];
}

export async function POST(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const b = body as Partial<CreateUnitBody>;

  if (!b.projectKey || typeof b.projectKey !== 'string') {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 });
  }
  if (!b.name || typeof b.name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const result = await createUnit({
    workspaceId: typeof b.workspaceId === 'string' ? b.workspaceId : 'default',
    projectKey: b.projectKey,
    name: b.name,
    description: typeof b.description === 'string' ? b.description : undefined,
    filePathPatterns: Array.isArray(b.filePathPatterns) ? (b.filePathPatterns as string[]) : undefined,
  });

  return NextResponse.json(result, { status: 201 });
}
