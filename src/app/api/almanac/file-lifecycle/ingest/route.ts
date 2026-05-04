import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface FilePath {
  path: string;
  first_sha: string | null;
  first_at: string | null;
  last_sha: string | null;
  last_at: string | null;
  status: 'extant' | 'deleted';
  rename_chain: string[];
}

interface IngestBody {
  workspaceId: string;
  repo: string;
  paths: FilePath[];
  done?: boolean;
}

function isValidFilePath(e: unknown): e is FilePath {
  if (!e || typeof e !== 'object') return false;
  const p = e as Record<string, unknown>;
  return (
    typeof p.path === 'string' &&
    p.path.length > 0 &&
    typeof p.status === 'string' &&
    (p.status === 'extant' || p.status === 'deleted') &&
    Array.isArray(p.rename_chain)
  );
}

/**
 * Build a path -> churn map by reading every code_event for the repo once
 * and bucketing in JS. Far cheaper than per-path SELECT against Turso (one
 * round-trip vs N). Drops the OR-clause approximation entirely — we parse
 * files_touched JSON exactly.
 */
async function buildChurnMap(
  repo: string,
  paths: FilePath[],
): Promise<Map<string, number>> {
  const db = getLibsqlDb();

  // Collect all names of interest: each path + its full rename_chain.
  const churn = new Map<string, number>();
  for (const p of paths) churn.set(p.path, 0);

  // Per path, the set of names that should count as a hit.
  const nameToPath = new Map<string, Set<string>>();
  for (const p of paths) {
    const allNames = Array.from(new Set([p.path, ...p.rename_chain]));
    for (const n of allNames) {
      let set = nameToPath.get(n);
      if (!set) {
        set = new Set();
        nameToPath.set(n, set);
      }
      set.add(p.path);
    }
  }

  const rows = await db
    .prepare(`SELECT files_touched FROM code_events WHERE repo = ?`)
    .all<{ files_touched: string }>(repo);

  for (const row of rows) {
    let files: string[];
    try {
      files = JSON.parse(row.files_touched ?? '[]') as string[];
    } catch {
      continue;
    }
    // Each path that this commit's files map to gets +1, deduped per commit.
    const hitPaths = new Set<string>();
    for (const f of files) {
      const targets = nameToPath.get(f);
      if (targets) for (const t of targets) hitPaths.add(t);
    }
    for (const p of hitPaths) churn.set(p, (churn.get(p) ?? 0) + 1);
  }

  return churn;
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
  if (!Array.isArray(b.paths)) {
    return NextResponse.json({ error: 'paths must be an array' }, { status: 400 });
  }

  for (const p of b.paths) {
    if (!isValidFilePath(p)) {
      return NextResponse.json({ error: 'invalid path entry shape' }, { status: 400 });
    }
  }

  const repo = b.repo;
  const paths = b.paths as FilePath[];

  // Single bulk read of code_events.files_touched, then bucket in JS.
  const churnMap = await buildChurnMap(repo, paths);

  for (const p of paths) {
    const churn = churnMap.get(p.path) ?? 0;

    await getLibsqlDb()
      .prepare(
        `INSERT INTO file_lifecycle
           (repo, path, first_sha, first_at, last_sha, last_at,
            status, rename_chain, churn, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(repo, path) DO UPDATE SET
           first_at    = CASE
                           WHEN excluded.first_at IS NOT NULL AND (first_at IS NULL OR excluded.first_at < first_at)
                           THEN excluded.first_at
                           ELSE first_at
                         END,
           last_at     = CASE
                           WHEN excluded.last_at IS NOT NULL AND (last_at IS NULL OR excluded.last_at > last_at)
                           THEN excluded.last_at
                           ELSE last_at
                         END,
           first_sha   = CASE
                           WHEN excluded.first_at IS NOT NULL AND (first_at IS NULL OR excluded.first_at < first_at)
                           THEN excluded.first_sha
                           ELSE first_sha
                         END,
           last_sha    = CASE
                           WHEN excluded.last_at IS NOT NULL AND (last_at IS NULL OR excluded.last_at > last_at)
                           THEN excluded.last_sha
                           ELSE last_sha
                         END,
           status      = excluded.status,
           rename_chain = excluded.rename_chain,
           churn       = excluded.churn`,
      )
      .run(
        repo,
        p.path,
        p.first_sha ?? null,
        p.first_at ?? null,
        p.last_sha ?? null,
        p.last_at ?? null,
        p.status,
        JSON.stringify(p.rename_chain),
        churn,
      );
  }

  return NextResponse.json({ ok: true, accepted: paths.length });
}
