/**
 * GET /api/almanac/docs/:doc_id
 * PATCH /api/almanac/docs/:doc_id  — currently supports updating { title }.
 *
 * Returns the doc + ordered sections + most-recent job per section.
 * Auth: browser session (withAuth). Workspace ownership check via resolveAlmanacWorkspaceId.
 */

import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';

export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
  workspace_id: string;
  project_key: string;
  repo_key: string;
  ref: string;
  status: string;
  outline: string | null;
  product_summary: string | null;
  title: string | null;
  created_at: string;
  completed_at: string | null;
}

const MAX_TITLE_LENGTH = 200;

interface SectionRow {
  section_id: string;
  ordinal: number;
  title: string;
  markdown: string | null;
  status: string;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  regenerated_at: string | null;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function GET(
  _req: Request,
  props: { params: Promise<{ doc_id: string }> },
): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { doc_id: docId } = await props.params;

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const doc = await db
    .prepare(
      `SELECT id, workspace_id, project_key, repo_key, ref, status, outline,
              product_summary, title, created_at, completed_at
       FROM almanac_docs WHERE id = ?`,
    )
    .get<DocRow>(docId);

  if (!doc) {
    return NextResponse.json({ error: 'Doc not found' }, { status: 404 });
  }

  // Workspace ownership check.
  const expectedWorkspaceId = await resolveAlmanacWorkspaceId(doc.project_key);
  if (doc.workspace_id !== expectedWorkspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const sections = await db
    .prepare(
      `SELECT section_id, ordinal, title, markdown, status, job_id,
              created_at, updated_at, regenerated_at
       FROM almanac_doc_sections
       WHERE doc_id = ?
       ORDER BY ordinal ASC`,
    )
    .all<SectionRow>(docId);

  // Fetch the most-recent job for each section that has a job_id.
  const jobIds = sections.map((s) => s.job_id).filter((id): id is string => id !== null);
  const jobsById = new Map<string, JobRow>();

  if (jobIds.length > 0) {
    const placeholders = jobIds.map(() => '?').join(', ');
    const jobs = await db
      .prepare(
        `SELECT id, kind, status, attempt, created_at, started_at, finished_at
         FROM agent_jobs
         WHERE id IN (${placeholders})`,
      )
      .all<JobRow>(...jobIds);
    for (const job of jobs) {
      jobsById.set(job.id, job);
    }
  }

  return NextResponse.json({
    doc: {
      id: doc.id,
      workspaceId: doc.workspace_id,
      projectKey: doc.project_key,
      repoKey: doc.repo_key,
      ref: doc.ref,
      status: doc.status,
      outline: doc.outline ? (JSON.parse(doc.outline) as unknown) : null,
      productSummary: doc.product_summary,
      title: doc.title,
      createdAt: doc.created_at,
      completedAt: doc.completed_at,
    },
    sections: sections.map((s) => ({
      sectionId: s.section_id,
      ordinal: s.ordinal,
      title: s.title,
      markdown: s.markdown,
      status: s.status,
      jobId: s.job_id,
      job: s.job_id ? (jobsById.get(s.job_id) ?? null) : null,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      regeneratedAt: s.regenerated_at,
    })),
  });
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ doc_id: string }> },
): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { doc_id: docId } = await props.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawTitle = (body as { title?: unknown })?.title;
  if (rawTitle !== null && typeof rawTitle !== 'string') {
    return NextResponse.json({ error: 'title must be a string or null' }, { status: 400 });
  }

  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : null;
  if (trimmed !== null && trimmed.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` },
      { status: 400 },
    );
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const doc = await db
    .prepare(`SELECT workspace_id, project_key FROM almanac_docs WHERE id = ?`)
    .get<{ workspace_id: string; project_key: string }>(docId);

  if (!doc) return NextResponse.json({ error: 'Doc not found' }, { status: 404 });

  const expectedWorkspaceId = await resolveAlmanacWorkspaceId(doc.project_key);
  if (doc.workspace_id !== expectedWorkspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Empty string normalises to null so the UI falls back to the default.
  const stored = trimmed === null || trimmed === '' ? null : trimmed;

  await db
    .prepare(`UPDATE almanac_docs SET title = ? WHERE id = ?`)
    .run(stored, docId);

  return NextResponse.json({ ok: true, title: stored });
}
