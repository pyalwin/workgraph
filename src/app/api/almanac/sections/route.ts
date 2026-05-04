/**
 * GET /api/almanac/sections?project_key=KAN
 *
 * Returns all almanac_sections for the given project_key, ordered by position.
 * Workspace-scoped: resolves workspaceId from the authenticated user's session.
 *
 * Auth: withAuth() — browser session required.
 *
 * Query params:
 *   - project_key  (required)
 *   - workspaceId  (optional, defaults to 'default')
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface SectionRow {
  id: string;
  workspace_id: string;
  project_key: string;
  unit_id: string | null;
  kind: string;
  anchor: string;
  position: number;
  title: string;
  markdown: string;
  diagram_blocks: string;
  source_hash: string;
  generated_at: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();

  const projectKey = req.nextUrl.searchParams.get('project_key');
  if (!projectKey) {
    return NextResponse.json({ error: 'project_key is required' }, { status: 400 });
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? 'default';

  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT id, workspace_id, project_key, unit_id, kind, anchor, position,
              title, markdown, diagram_blocks, source_hash, generated_at, created_at
       FROM almanac_sections
       WHERE project_key = ?
         AND workspace_id = ?
       ORDER BY position ASC`,
    )
    .all<SectionRow>(projectKey, workspaceId);

  const sections = rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    project_key: r.project_key,
    unit_id: r.unit_id,
    kind: r.kind,
    anchor: r.anchor,
    position: r.position,
    title: r.title,
    markdown: r.markdown,
    diagram_blocks: safeJsonArray(r.diagram_blocks),
    source_hash: r.source_hash,
    generated_at: r.generated_at,
    created_at: r.created_at,
  }));

  return NextResponse.json({ sections });
}

function safeJsonArray(s: string): unknown[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
