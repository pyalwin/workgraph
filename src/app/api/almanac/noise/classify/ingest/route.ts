import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

type IntentKind = 'introduce' | 'extend' | 'refactor' | 'fix' | 'revert' | 'mixed';
type ArchSig = 'low' | 'medium' | 'high';

interface ClassifyResult {
  sha: string;
  intent: IntentKind;
  architectural_significance: ArchSig;
  is_feature_evolution: boolean;
}

interface IngestBody {
  workspaceId: string;
  repo: string;
  results: ClassifyResult[];
}

const VALID_INTENTS = new Set<string>(['introduce', 'extend', 'refactor', 'fix', 'revert', 'mixed']);
const VALID_ARCH_SIG = new Set<string>(['low', 'medium', 'high']);

function isValidResult(r: unknown): r is ClassifyResult {
  if (!r || typeof r !== 'object') return false;
  const v = r as Record<string, unknown>;
  return (
    typeof v.sha === 'string' &&
    typeof v.intent === 'string' && VALID_INTENTS.has(v.intent) &&
    typeof v.architectural_significance === 'string' && VALID_ARCH_SIG.has(v.architectural_significance) &&
    typeof v.is_feature_evolution === 'boolean'
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
  if (!Array.isArray(b.results)) {
    return NextResponse.json({ error: 'results must be an array' }, { status: 400 });
  }

  for (const r of b.results) {
    if (!isValidResult(r)) {
      return NextResponse.json({ error: 'invalid result shape' }, { status: 400 });
    }
  }

  const db = getLibsqlDb();
  const results = b.results as ClassifyResult[];

  let accepted = 0;
  let skipped = 0;

  // One UPDATE per sha; skip rows where evolution_override IS NOT NULL (admin-pinned)
  for (const r of results) {
    const res = await db
      .prepare(
        `UPDATE code_events
         SET intent = ?,
             architectural_significance = ?,
             is_feature_evolution = ?,
             classifier_run_at = datetime('now')
         WHERE repo = ?
           AND sha = ?
           AND evolution_override IS NULL`,
      )
      .run(
        r.intent,
        r.architectural_significance,
        r.is_feature_evolution ? 1 : 0,
        b.repo,
        r.sha,
      );

    // changes = 0 means either sha doesn't exist or evolution_override was set
    if ((res.changes ?? 0) > 0) {
      accepted++;
    } else {
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, accepted, skipped });
}
