/**
 * POST /api/almanac/units/[id]/merge
 *
 * Merge unit [id] into the surviving unit specified in body.
 *
 * Body: { into: string }
 *
 * Auth: withAuth() — browser session required.
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { mergeUnits } from '@/lib/almanac/unit-mutations';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

export const dynamic = 'force-dynamic';

interface MergeBody {
  into: string;
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

  const b = body as Partial<MergeBody>;
  if (!b.into || typeof b.into !== 'string') {
    return NextResponse.json({ error: '"into" (surviving unit id) is required' }, { status: 400 });
  }

  const result = await mergeUnits({ absorbedId: id, survivingId: b.into });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
