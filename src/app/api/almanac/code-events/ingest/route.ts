import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';
import { classifyMechanical } from '@/lib/almanac/noise-classifier';

export const dynamic = 'force-dynamic';

interface CodeEvent {
  id: string;
  workspace_id: string;
  repo: string;
  sha: string;
  pr_number: number | null;
  kind: 'pr_merged' | 'direct_commit' | 'release';
  author_login: string | null;
  author_email: string | null;
  occurred_at: string;
  message: string;
  files_touched: string[];
  additions: number;
  deletions: number;
}

interface IngestBody {
  workspaceId: string;
  repo: string;
  events: CodeEvent[];
  cursor?: { last_sha: string; last_occurred_at: string };
  done?: boolean;
}

function isValidEvent(e: unknown): e is CodeEvent {
  if (!e || typeof e !== 'object') return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === 'string' &&
    typeof ev.workspace_id === 'string' &&
    typeof ev.repo === 'string' &&
    typeof ev.sha === 'string' &&
    typeof ev.kind === 'string' &&
    ['pr_merged', 'direct_commit', 'release'].includes(ev.kind as string) &&
    typeof ev.occurred_at === 'string' &&
    Array.isArray(ev.files_touched)
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
  if (!Array.isArray(b.events)) {
    return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
  }

  for (const e of b.events) {
    if (!isValidEvent(e)) {
      return NextResponse.json({ error: 'invalid event shape' }, { status: 400 });
    }
  }

  const db = getLibsqlDb();
  const events = b.events as CodeEvent[];

  let accepted = 0;

  if (events.length > 0) {
    // libsql supports multi-row positional inserts — batch in one statement
    const placeholders = events
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))')
      .join(', ');

    const args: (string | number | null)[] = [];
    for (const e of events) {
      const { noise_class, is_feature_evolution } = classifyMechanical({
        message: e.message ?? '',
        files: e.files_touched ?? [],
        additions: e.additions ?? 0,
        deletions: e.deletions ?? 0,
      });

      args.push(
        e.id,
        e.workspace_id,
        e.repo,
        e.sha,
        e.pr_number ?? null,
        e.kind,
        e.author_login ?? null,
        e.author_email ?? null,
        e.occurred_at,
        e.message ?? null,
        JSON.stringify(e.files_touched),
        e.additions ?? 0,
        e.deletions ?? 0,
        noise_class,
        is_feature_evolution,
        // classifier_run_at is inlined as datetime('now') in the placeholder
      );
    }

    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO code_events
           (id, workspace_id, repo, sha, pr_number, kind,
            author_login, author_email, occurred_at, message,
            files_touched, additions, deletions,
            noise_class, is_feature_evolution, classifier_run_at)
         VALUES ${placeholders}`,
      )
      .run(...args);

    // result.changes = number of rows actually inserted (IGNORE skips counted as 0)
    accepted = result.changes ?? 0;
  }

  const ignored = events.length - accepted;

  // Derive backfill status — 'partial' during a run, 'ok' when agent signals done
  const newStatus = b.done === true ? 'ok' : 'partial';

  // Upsert backfill state; only update cursor if agent provided one
  if (b.cursor) {
    await db
      .prepare(
        `INSERT INTO code_events_backfill_state
           (repo, last_sha, last_occurred_at, total_events, last_run_at, last_status)
         VALUES (?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(repo) DO UPDATE SET
           last_sha = excluded.last_sha,
           last_occurred_at = excluded.last_occurred_at,
           total_events = total_events + ?,
           last_run_at = datetime('now'),
           last_status = ?`,
      )
      .run(
        b.repo,
        b.cursor.last_sha,
        b.cursor.last_occurred_at,
        accepted,          // initial total_events on first insert
        newStatus,
        accepted,          // delta for ON CONFLICT path
        newStatus,
      );
  } else {
    // No cursor in this batch — still track count + status, leave sha/occurred_at alone
    await db
      .prepare(
        `INSERT INTO code_events_backfill_state
           (repo, total_events, last_run_at, last_status)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(repo) DO UPDATE SET
           total_events = total_events + ?,
           last_run_at = datetime('now'),
           last_status = ?`,
      )
      .run(b.repo, accepted, newStatus, accepted, newStatus);
  }

  return NextResponse.json({ ok: true, accepted, ignored });
}
