/**
 * POST /api/almanac/docs/:doc_id/sections/:section_id
 *
 * Ingest endpoint called by the agent at the end of an almanac.draft-section job.
 * Auth: agent bearer token. Agent workspace_id must match the doc's.
 *
 * Body: { markdown: string }
 * Validates: starts with '## ', non-empty.
 * Updates the section row (markdown, status='done', updated_at).
 * Bumps regenerated_at if this is a regen (status was 'drafting' and markdown
 * already existed).
 * Sends Inngest event 'almanac/section.completed'.
 */

import { NextResponse } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

interface DocRow {
  workspace_id: string;
}

interface SectionRow {
  status: string;
  markdown: string | null;
}

export async function POST(
  req: Request,
  props: { params: Promise<{ doc_id: string; section_id: string }> },
): Promise<NextResponse> {
  const identity = await verifyAgentToken(req);
  if (!identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { doc_id: docId, section_id: sectionId } = await props.params;

  let body: { markdown?: unknown };
  try {
    body = (await req.json()) as { markdown?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.markdown !== 'string' || !body.markdown.trim()) {
    return NextResponse.json({ error: 'markdown must be a non-empty string' }, { status: 422 });
  }

  const markdown = body.markdown.trim();

  if (!markdown.startsWith('## ')) {
    return NextResponse.json(
      { error: 'markdown must start with "## "' },
      { status: 422 },
    );
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const doc = await db
    .prepare(`SELECT workspace_id FROM almanac_docs WHERE id = ?`)
    .get<DocRow>(docId);

  if (!doc) {
    return NextResponse.json({ error: 'Doc not found' }, { status: 404 });
  }

  if (doc.workspace_id !== identity.workspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const section = await db
    .prepare(
      `SELECT status, markdown FROM almanac_doc_sections WHERE doc_id = ? AND section_id = ?`,
    )
    .get<SectionRow>(docId, sectionId);

  if (!section) {
    return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  }

  // Regen detection: section was drafting AND already had markdown content.
  const isRegen = section.status === 'drafting' && section.markdown !== null && section.markdown !== '';

  if (isRegen) {
    await db
      .prepare(
        `UPDATE almanac_doc_sections
         SET markdown = ?, status = 'done', updated_at = datetime('now'), regenerated_at = datetime('now')
         WHERE doc_id = ? AND section_id = ?`,
      )
      .run(markdown, docId, sectionId);
  } else {
    await db
      .prepare(
        `UPDATE almanac_doc_sections
         SET markdown = ?, status = 'done', updated_at = datetime('now')
         WHERE doc_id = ? AND section_id = ?`,
      )
      .run(markdown, docId, sectionId);
  }

  await inngest.send({
    name: 'almanac/section.completed',
    data: { doc_id: docId, section_id: sectionId },
  });

  return NextResponse.json({ ok: true });
}
