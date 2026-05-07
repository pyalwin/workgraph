/**
 * POST /api/almanac/docs/:doc_id/outline
 *
 * Ingest endpoint called by the agent at the end of the almanac.outline job.
 * Auth: agent bearer token. The agent's workspace_id must match the doc's.
 *
 * Body: Outline JSON (product_summary + sections[]).
 * On success:
 *   - stores outline + product_summary on the doc
 *   - sets doc status='drafting'
 *   - inserts one almanac_doc_sections row per section (status='queued')
 *   - sends Inngest event 'almanac/outline.received'
 */

import { NextResponse } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

interface SubsectionInput {
  title?: unknown;
  abstract?: unknown;
}

interface SectionInput {
  id?: unknown;
  title?: unknown;
  role?: unknown;
  abstract?: unknown;
  subsections?: unknown;
  diagrams_expected?: unknown;
}

interface OutlineBody {
  product_summary?: unknown;
  sections?: unknown;
}

interface DocRow {
  id: string;
  workspace_id: string;
  status: string;
}

function validateOutline(body: OutlineBody): { valid: true; outline: OutlineBody } | { valid: false; error: string } {
  if (typeof body.product_summary !== 'string' || !body.product_summary.trim()) {
    return { valid: false, error: 'product_summary must be a non-empty string' };
  }

  if (!Array.isArray(body.sections) || body.sections.length === 0) {
    return { valid: false, error: 'sections must be a non-empty array' };
  }

  for (let i = 0; i < body.sections.length; i++) {
    const s = body.sections[i] as SectionInput;
    if (typeof s !== 'object' || s === null) {
      return { valid: false, error: `sections[${i}] must be an object` };
    }
    if (typeof s.id !== 'string' || !s.id.trim()) {
      return { valid: false, error: `sections[${i}].id must be a non-empty string` };
    }
    if (typeof s.title !== 'string' || !s.title.trim()) {
      return { valid: false, error: `sections[${i}].title must be a non-empty string` };
    }
    if (s.role !== 'required' && s.role !== 'optional') {
      return { valid: false, error: `sections[${i}].role must be 'required' or 'optional'` };
    }
    if (typeof s.abstract !== 'string' || !s.abstract.trim()) {
      return { valid: false, error: `sections[${i}].abstract must be a non-empty string` };
    }
    if (!Array.isArray(s.subsections)) {
      return { valid: false, error: `sections[${i}].subsections must be an array` };
    }
    for (let j = 0; j < (s.subsections as SubsectionInput[]).length; j++) {
      const sub = (s.subsections as SubsectionInput[])[j];
      if (typeof sub !== 'object' || sub === null) {
        return { valid: false, error: `sections[${i}].subsections[${j}] must be an object` };
      }
      if (typeof sub.title !== 'string' || !sub.title.trim()) {
        return { valid: false, error: `sections[${i}].subsections[${j}].title must be a non-empty string` };
      }
    }
    if (!Array.isArray(s.diagrams_expected)) {
      return { valid: false, error: `sections[${i}].diagrams_expected must be an array` };
    }
  }

  return { valid: true, outline: body };
}

export async function POST(
  req: Request,
  props: { params: Promise<{ doc_id: string }> },
): Promise<NextResponse> {
  const identity = await verifyAgentToken(req);
  if (!identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { doc_id: docId } = await props.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Accept either flat `{ product_summary, sections }` or wrapped
  // `{ outline: {...}, ref?: '...' }`. The agent currently sends the wrapped
  // form so it can include the resolved SHA alongside the outline.
  const body: OutlineBody =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'outline' in (raw as object)
      ? ((raw as { outline: OutlineBody }).outline)
      : (raw as OutlineBody);

  const validation = validateOutline(body);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 422 });
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const doc = await db
    .prepare(`SELECT id, workspace_id, status FROM almanac_docs WHERE id = ?`)
    .get<DocRow>(docId);

  if (!doc) {
    return NextResponse.json({ error: 'Doc not found' }, { status: 404 });
  }

  if (doc.workspace_id !== identity.workspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (doc.status !== 'outlining') {
    return NextResponse.json(
      { error: `Doc is in status '${doc.status}', expected 'outlining'` },
      { status: 409 },
    );
  }

  const sections = body.sections as SectionInput[];
  const outlineJson = JSON.stringify(body);

  // Update doc: store outline, product_summary, set status='drafting'.
  await db
    .prepare(
      `UPDATE almanac_docs
       SET outline = ?, product_summary = ?, status = 'drafting'
       WHERE id = ?`,
    )
    .run(outlineJson, body.product_summary as string, docId);

  // Insert one almanac_doc_sections row per section.
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    await db
      .prepare(
        `INSERT INTO almanac_doc_sections
           (doc_id, section_id, ordinal, title, status)
         VALUES (?, ?, ?, ?, 'queued')
         ON CONFLICT (doc_id, section_id) DO NOTHING`,
      )
      .run(docId, (s.id as string).trim(), i, (s.title as string).trim());
  }

  // Fire Inngest event to fan out section drafting jobs.
  await inngest.send({
    name: 'almanac/outline.received',
    data: { doc_id: docId },
  });

  return NextResponse.json({ ok: true });
}
