/**
 * Unified "regenerate everything" endpoint.
 *
 * Fires every project-scoped refresh event so the project detail page
 * (recap, README, OKRs, action items, backlog) repopulates after a binding
 * change. Called automatically by github-attach; also exposed as a
 * "Regenerate" button in the UI.
 *
 * Each refresh is its own Inngest event; this endpoint just dispatches
 * them and returns. The actual generation happens asynchronously.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const projectKey = params.key.toUpperCase();

  const events = [
    { name: 'workgraph/project-summary.regen', data: { projectKey, projectName: projectKey } },
    { name: 'workgraph/project.readme.refresh', data: { projectKey } },
    { name: 'workgraph/project.okrs.refresh', data: { projectKey } },
    { name: 'workgraph/project.action-items.refresh', data: { projectKey } },
    { name: 'workgraph/project.backlog.refresh', data: { projectKey } },
  ];

  const results = await Promise.allSettled(events.map((e) => inngest.send(e)));

  const dispatched: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') dispatched.push(events[i].name);
    else failed.push({ name: events[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });

  return NextResponse.json({
    ok: failed.length === 0,
    projectKey,
    dispatched,
    failed,
  });
}
