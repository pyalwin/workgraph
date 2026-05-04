/**
 * POST /api/admin/almanac/sections/regenerate
 *
 * Triggers a synchronous section regeneration run for the given project.
 * Builds deterministic skeleton sections, stores them, and enqueues narration
 * jobs for any sections whose source_hash has changed.
 *
 * Auth: withAuth() — browser session required.
 *
 * Body:
 *   {
 *     projectKey: string;
 *     forceAll?: boolean;
 *     cli?: 'codex' | 'claude' | 'gemini';
 *     model?: string;
 *   }
 *
 * Returns: RegenerateSummary
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { regenerateSections } from '@/lib/almanac/section-runner';

export const dynamic = 'force-dynamic';

interface RegenBody {
  projectKey: string;
  forceAll?: boolean;
  cli?: string;
  model?: string;
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

  const b = body as Partial<RegenBody>;
  if (!b.projectKey || typeof b.projectKey !== 'string') {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 });
  }

  // Workspace resolution: use 'default' as this single-workspace app uses
  // that convention throughout (see backfill route pattern).
  const workspaceId = 'default';

  const cli = b.cli === 'claude' || b.cli === 'gemini' ? b.cli : 'codex';

  const summary = await regenerateSections(workspaceId, b.projectKey, {
    forceAll: b.forceAll === true,
    cli,
    model: typeof b.model === 'string' ? b.model : undefined,
  });

  return NextResponse.json({ ok: true, summary });
}
