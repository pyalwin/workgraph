/**
 * POST /api/admin/almanac/backfill
 *
 * Emits a `workgraph/almanac.backfill` Inngest event which triggers the
 * `almanac-code-events-backfill` function. Optionally scoped to a single
 * repo via body.repo ("owner/name") or a specific workspace via body.workspaceId.
 *
 * Auth: requires an authenticated session.
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { workspaceId?: string; repo?: string };

  await inngest.send({
    name: 'workgraph/almanac.backfill',
    data: { workspaceId: body.workspaceId ?? 'default', repo: body.repo },
  });

  return NextResponse.json({ ok: true });
}
