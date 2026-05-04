/**
 * PATCH /api/almanac/units/[id]  — rename / update description
 * DELETE /api/almanac/units/[id] — archive (soft delete, status='archived')
 *
 * Auth: withAuth() — browser session required.
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { renameUnit, archiveUnit } from '@/lib/almanac/unit-mutations';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

export const dynamic = 'force-dynamic';

interface PatchBody {
  name?: string;
  description?: string;
}

export async function PATCH(
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

  const b = body as Partial<PatchBody>;

  if (b.name !== undefined && typeof b.name !== 'string') {
    return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
  }

  const result = await renameUnit({
    unitId: id,
    name: b.name,
    description: b.description,
  });

  if (!result) {
    return NextResponse.json({ error: 'Unit not found' }, { status: 404 });
  }

  return NextResponse.json(result);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();

  const { id } = await params;

  const result = await archiveUnit(id);
  if (!result.ok) {
    return NextResponse.json({ error: 'Unit not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
