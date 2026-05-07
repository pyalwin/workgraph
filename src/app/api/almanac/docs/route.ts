/**
 * GET  /api/almanac/docs?projectKey=...
 * POST /api/almanac/docs
 *
 * GET: List all docs for a project. Returns { docs: [...] }.
 * POST: Creates a new almanac doc and queues the outline agent job.
 *   Body: { projectKey, repoKey, ref? }
 *   Returns: { doc_id, job_id }
 *
 * Auth: browser session (withAuth).
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';

export const dynamic = 'force-dynamic';

interface DocListRow {
  id: string;
  repo_key: string;
  ref: string;
  status: string;
  title: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectKey = req.nextUrl.searchParams.get('projectKey');
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey query param is required' }, { status: 400 });
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const docs = await db
    .prepare(
      `SELECT id, repo_key, ref, status, title, created_at, completed_at
       FROM almanac_docs
       WHERE project_key = ?
       ORDER BY created_at DESC`,
    )
    .all<DocListRow>(projectKey.toUpperCase());

  return NextResponse.json({ docs });
}

interface CreateDocBody {
  projectKey?: unknown;
  repoKey?: unknown;
  ref?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: CreateDocBody;
  try {
    body = (await req.json()) as CreateDocBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.projectKey !== 'string' || !body.projectKey.trim()) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 });
  }
  if (typeof body.repoKey !== 'string' || !body.repoKey.trim()) {
    return NextResponse.json({ error: 'repoKey is required' }, { status: 400 });
  }

  const projectKey = body.projectKey.trim().toUpperCase();
  const repoKey = body.repoKey.trim();
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : 'main';

  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const docId = uuid();
  const jobId = uuid();

  await db
    .prepare(
      `INSERT INTO almanac_docs (id, workspace_id, project_key, repo_key, ref, status)
       VALUES (?, ?, ?, ?, ?, 'outlining')`,
    )
    .run(docId, workspaceId, projectKey, repoKey, ref);

  const params = JSON.stringify({ workspaceId, projectKey, repoKey, ref, doc_id: docId });

  await db
    .prepare(
      `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
       VALUES (?, ?, 'almanac.outline', 'queued', ?)`,
    )
    .run(jobId, workspaceId, params);

  return NextResponse.json({ doc_id: docId, job_id: jobId }, { status: 201 });
}
