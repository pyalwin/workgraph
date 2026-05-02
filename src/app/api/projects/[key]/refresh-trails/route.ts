/**
 * Manual trigger for "refresh PR trails for this project's workspace."
 * Project-scoped only in name — under the hood we kick the workspace's
 * github connector since PRs aren't project-scoped (a single repo's PRs
 * may attach to many projects' tickets). The event is queued via Inngest
 * because trails sync can take seconds-to-minutes; the UI polls.
 *
 * Body:
 *   { since?: '7d' | '30d' | 'all' | <ISO date> }
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  props: { params: Promise<{ key: string }> },
) {
  await props.params;  // project key not used directly — see header comment
  await ensureSchemaAsync();

  let body: { since?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine; defaults apply
  }

  const db = getLibsqlDb();
  const githubSlots = await db
    .prepare(
      `SELECT workspace_id, slot FROM workspace_connector_configs
       WHERE source = 'github' AND status != 'skipped'`,
    )
    .all<{ workspace_id: string; slot: string }>();

  if (githubSlots.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'No github connector configured' },
      { status: 400 },
    );
  }

  await Promise.all(
    githubSlots.map((s) =>
      inngest.send({
        name: 'workgraph/github.trails.refresh',
        data: { workspaceId: s.workspace_id, slot: s.slot, since: body.since ?? null },
      }),
    ),
  );

  return NextResponse.json({ ok: true, queued: githubSlots.length });
}
