import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

// Chunk size for UPDATE ... WHERE sha IN (...) — avoids hitting SQLite bind limits
const SHA_CHUNK_SIZE = 200;

interface ClusterPayload {
  unit_id: string;
  file_set: string[];
  member_shas: string[];
  first_seen_at: string;
  last_active_at: string;
}

interface IngestBody {
  workspaceId: string;
  repo: string;
  clusters: ClusterPayload[];
}

function isValidCluster(c: unknown): c is ClusterPayload {
  if (!c || typeof c !== 'object') return false;
  const cl = c as Record<string, unknown>;
  return (
    typeof cl.unit_id === 'string' &&
    Array.isArray(cl.file_set) &&
    Array.isArray(cl.member_shas) &&
    typeof cl.first_seen_at === 'string' &&
    typeof cl.last_active_at === 'string'
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
  if (!b.repo || typeof b.repo !== 'string') {
    return NextResponse.json({ error: 'missing repo' }, { status: 400 });
  }
  if (!Array.isArray(b.clusters)) {
    return NextResponse.json({ error: 'clusters must be an array' }, { status: 400 });
  }

  for (const c of b.clusters) {
    if (!isValidCluster(c)) {
      return NextResponse.json({ error: 'invalid cluster shape' }, { status: 400 });
    }
  }

  const db = getLibsqlDb();
  const clusters = b.clusters as ClusterPayload[];

  for (const cluster of clusters) {
    const filePathPatterns = JSON.stringify(cluster.file_set);

    // UPSERT draft unit; only update last_active_at and file_path_patterns on conflict.
    // Preserve name/description written by a prior naming pass.
    await db
      .prepare(
        `INSERT INTO functional_units
           (id, workspace_id, name, description, status, detected_from,
            file_path_patterns, file_set_hash,
            first_seen_at, last_active_at,
            keywords, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'active', 'co_change',
                 ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           last_active_at     = excluded.last_active_at,
           -- update file patterns only if the hash genuinely changed (shouldn't happen,
           -- since unit_id IS the hash, but be safe)
           file_path_patterns = CASE
                                  WHEN file_set_hash != excluded.file_set_hash
                                  THEN excluded.file_path_patterns
                                  ELSE file_path_patterns
                                END,
           updated_at         = datetime('now')`,
      )
      .run(
        cluster.unit_id,
        b.workspaceId,
        filePathPatterns,
        cluster.unit_id, // file_set_hash == unit_id by spec
        cluster.first_seen_at,
        cluster.last_active_at,
      );

    // Backfill code_events.functional_unit_id for all member SHAs.
    // Chunk to stay under SQLite bind parameter limits (999 max).
    const shas = cluster.member_shas;
    for (let i = 0; i < shas.length; i += SHA_CHUNK_SIZE) {
      const chunk = shas.slice(i, i + SHA_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      await db
        .prepare(
          `UPDATE code_events
           SET functional_unit_id = ?
           WHERE repo = ? AND sha IN (${placeholders})`,
        )
        .run(cluster.unit_id, b.repo, ...chunk);
    }
  }

  return NextResponse.json({ ok: true, accepted: clusters.length });
}
