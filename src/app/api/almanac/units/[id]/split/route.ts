/**
 * POST /api/almanac/units/[id]/split
 *
 * Split off matching code events from unit [id] into a new unit.
 *
 * Body: {
 *   filter: { pathPattern?: string; messageContains?: string };
 *   newName: string;
 *   newDescription?: string;
 * }
 *
 * Auth: withAuth() — browser session required.
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { splitUnit } from '@/lib/almanac/unit-mutations';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

export const dynamic = 'force-dynamic';

interface SplitBody {
  filter: { pathPattern?: string; messageContains?: string };
  newName: string;
  newDescription?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const b = body as Partial<SplitBody>;

  if (!b.newName || typeof b.newName !== 'string') {
    return NextResponse.json({ error: 'newName is required' }, { status: 400 });
  }

  if (!b.filter || typeof b.filter !== 'object') {
    return NextResponse.json({ error: 'filter is required' }, { status: 400 });
  }

  const filter = b.filter as { pathPattern?: unknown; messageContains?: unknown };

  const result = await splitUnit({
    sourceUnitId: id,
    filter: {
      pathPattern: typeof filter.pathPattern === 'string' ? filter.pathPattern : undefined,
      messageContains: typeof filter.messageContains === 'string' ? filter.messageContains : undefined,
    },
    newName: b.newName,
    newDescription: typeof b.newDescription === 'string' ? b.newDescription : undefined,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
