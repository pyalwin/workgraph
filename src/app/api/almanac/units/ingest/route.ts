import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface UnitResult {
  unit_id: string;
  name: string;
  description: string;
  keywords: string[];
}

interface IngestBody {
  workspaceId: string;
  results: UnitResult[];
}

function isValidResult(r: unknown): r is UnitResult {
  if (!r || typeof r !== 'object') return false;
  const u = r as Record<string, unknown>;
  return (
    typeof u.unit_id === 'string' &&
    typeof u.name === 'string' &&
    typeof u.description === 'string' &&
    Array.isArray(u.keywords)
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
  if (!Array.isArray(b.results)) {
    return NextResponse.json({ error: 'results must be an array' }, { status: 400 });
  }

  for (const r of b.results) {
    if (!isValidResult(r)) {
      return NextResponse.json({ error: 'invalid result shape' }, { status: 400 });
    }
  }

  const db = getLibsqlDb();
  const results = b.results as UnitResult[];

  let accepted = 0;
  let skipped = 0;

  for (const r of results) {
    // Only update co_change units — jira_epic_alias and manual units keep their names
    const upd = await db
      .prepare(
        `UPDATE functional_units
         SET name        = ?,
             description = ?,
             keywords    = ?,
             updated_at  = datetime('now')
         WHERE id = ?
           AND detected_from = 'co_change'`,
      )
      .run(
        r.name,
        r.description,
        JSON.stringify(r.keywords),
        r.unit_id,
      );

    if ((upd.changes ?? 0) > 0) {
      accepted++;
    } else {
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, accepted, skipped });
}
