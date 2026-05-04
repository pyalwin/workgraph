/**
 * POST /api/almanac/sections/ingest
 *
 * Agent-facing endpoint. Updates existing almanac_sections rows with
 * LLM-generated markdown. Only UPDATE is allowed — the section row must
 * already exist (the section-runner pre-creates skeletons).
 *
 * Auth: verifyAgentRequest (Bearer token, same as all agent ingest routes).
 *
 * Body:
 *   {
 *     workspaceId: string;
 *     sections: Array<{
 *       project_key: string;
 *       anchor: string;
 *       title: string;
 *       markdown: string;
 *       diagram_blocks?: unknown[];  // kept from skeleton if omitted
 *       source_hash: string;
 *     }>
 *   }
 *
 * Returns: { updated: N }
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface SectionUpdate {
  project_key: string;
  anchor: string;
  title: string;
  markdown: string;
  diagram_blocks?: unknown[];
  source_hash: string;
}

interface IngestBody {
  workspaceId: string;
  sections: SectionUpdate[];
}

function isValidUpdate(s: unknown): s is SectionUpdate {
  if (!s || typeof s !== 'object') return false;
  const u = s as Record<string, unknown>;
  return (
    typeof u.project_key === 'string' &&
    typeof u.anchor === 'string' &&
    typeof u.title === 'string' &&
    typeof u.markdown === 'string' &&
    typeof u.source_hash === 'string'
  );
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  const identity = await verifyAgentRequest(req);
  if (!identity) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const b = body as Partial<IngestBody>;

  if (!b.workspaceId || typeof b.workspaceId !== 'string') {
    return NextResponse.json({ error: 'missing workspaceId' }, { status: 400 });
  }
  if (!Array.isArray(b.sections)) {
    return NextResponse.json({ error: 'sections must be an array' }, { status: 400 });
  }

  for (const s of b.sections) {
    if (!isValidUpdate(s)) {
      return NextResponse.json({ error: 'invalid section shape' }, { status: 400 });
    }
  }

  const db = getLibsqlDb();
  let updated = 0;
  let rejected = 0;

  for (const s of b.sections as SectionUpdate[]) {
    // Only update if the row already exists — section-runner must have created it.
    // diagram_blocks: if not provided by agent, preserve the existing skeleton value.
    const result = await db
      .prepare(
        `UPDATE almanac_sections
         SET title        = ?,
             markdown     = ?,
             diagram_blocks = CASE WHEN ? IS NOT NULL THEN ? ELSE diagram_blocks END,
             source_hash  = ?,
             generated_at = datetime('now')
         WHERE project_key = ?
           AND anchor = ?
           AND workspace_id = ?`,
      )
      .run(
        s.title,
        s.markdown,
        s.diagram_blocks !== undefined ? JSON.stringify(s.diagram_blocks) : null,
        s.diagram_blocks !== undefined ? JSON.stringify(s.diagram_blocks) : null,
        s.source_hash,
        s.project_key,
        s.anchor,
        b.workspaceId,
      );

    if ((result.changes ?? 0) > 0) {
      updated++;
    } else {
      rejected++;
    }
  }

  return NextResponse.json({ updated, rejected });
}
