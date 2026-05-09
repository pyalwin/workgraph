/**
 * Bulk ingest endpoint for the local agent's almanac.backlog job to POST
 * its inferred items. Stable-id idempotent — re-running the job won't
 * clobber user state on existing items.
 *
 * Accepts a single bearer token (the agent's token, same as the rest of
 * the agent API) OR a logged-in user session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import {
  ingestBacklogItem,
  isBacklogKind,
  type BacklogEvidence,
} from '@/lib/project-backlog';

export const dynamic = 'force-dynamic';

interface IncomingItem {
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  evidence?: unknown;
}

interface IngestBody {
  items?: unknown;
}

function parseEvidence(raw: unknown): BacklogEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BacklogEvidence = {};
  if (Array.isArray(r.paths)) out.paths = r.paths.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(r.refs)) out.refs = r.refs.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(r.commits)) out.commits = r.commits.filter((v): v is string => typeof v === 'string');
  if (typeof r.notes === 'string') out.notes = r.notes;
  return Object.keys(out).length > 0 ? out : null;
}

export async function POST(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  // Allow either an authenticated user OR an agent bearer token. The agent
  // sends its token via apiFetch; the route is shared with browser-driven
  // refresh that goes through authkit.
  const auth = await withAuth().catch(() => ({ user: null }));
  const hasBearer = !!req.headers.get('authorization');
  if (!auth.user && !hasBearer) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: 'items must be an array' }, { status: 400 });
  }

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  const incoming = body.items as IncomingItem[];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const raw of incoming) {
    if (!isBacklogKind(raw.kind)) {
      skipped++;
      continue;
    }
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      skipped++;
      continue;
    }
    try {
      const description = typeof raw.description === 'string' ? raw.description : null;
      const evidence = parseEvidence(raw.evidence);
      // ingestBacklogItem returns the resulting row; we use createdAt vs
      // updatedAt to distinguish insert vs update.
      const item = await ingestBacklogItem({
        workspaceId,
        projectKey,
        kind: raw.kind,
        title: raw.title,
        description,
        source: 'almanac',
        aiGenerated: true,
        evidence,
      });
      if (item.createdAt === item.updatedAt) inserted++;
      else updated++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return NextResponse.json({
    ok: true,
    received: incoming.length,
    inserted,
    updated,
    skipped,
    errors: errors.slice(0, 10),
  });
}
