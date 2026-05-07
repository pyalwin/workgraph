/**
 * POST /api/almanac/docs/:doc_id/sections/:section_id/regen
 *
 * Per-section regeneration. Queues a fresh almanac.draft-section job.
 * Auth: browser session (withAuth). Workspace ownership check.
 *
 * Body: empty or { ref?: string }
 * Returns: { job_id }
 */

import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';

export const dynamic = 'force-dynamic';

interface DocRow {
  workspace_id: string;
  project_key: string;
  repo_key: string;
  ref: string;
  outline: string | null;
}

interface SectionRow {
  section_id: string;
  status: string;
}

export async function POST(
  req: Request,
  props: { params: Promise<{ doc_id: string; section_id: string }> },
): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { doc_id: docId, section_id: sectionId } = await props.params;

  // Body is optional — ref override is a nice-to-have.
  let refOverride: string | null = null;
  try {
    const body = (await req.json()) as { ref?: unknown };
    if (typeof body.ref === 'string' && body.ref.trim()) {
      refOverride = body.ref.trim();
    }
  } catch {
    // Body is optional — ignore parse errors.
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const doc = await db
    .prepare(
      `SELECT workspace_id, project_key, repo_key, ref, outline
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

  if (!doc.outline) {
    return NextResponse.json(
      { error: 'Doc has no outline yet; cannot regen a section' },
      { status: 409 },
    );
  }

  const section = await db
    .prepare(
      `SELECT section_id, status FROM almanac_doc_sections WHERE doc_id = ? AND section_id = ?`,
    )
    .get<SectionRow>(docId, sectionId);

  if (!section) {
    return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  }

  const effectiveRef = refOverride ?? doc.ref;
  const newJobId = uuid();

  const params = JSON.stringify({
    workspaceId: doc.workspace_id,
    projectKey: doc.project_key,
    repoKey: doc.repo_key,
    ref: effectiveRef,
    doc_id: docId,
    section_id: sectionId,
    outline: JSON.parse(doc.outline) as unknown,
  });

  await db
    .prepare(
      `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
       VALUES (?, ?, 'almanac.draft-section', 'queued', ?)`,
    )
    .run(newJobId, doc.workspace_id, params);

  // Set section back to 'drafting', clear job_id (new job will own it).
  await db
    .prepare(
      `UPDATE almanac_doc_sections
       SET status = 'drafting', job_id = ?, updated_at = datetime('now')
       WHERE doc_id = ? AND section_id = ?`,
    )
    .run(newJobId, docId, sectionId);

  return NextResponse.json({ job_id: newJobId });
}
