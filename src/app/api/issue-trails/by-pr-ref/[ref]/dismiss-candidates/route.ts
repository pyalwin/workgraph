/**
 * POST /api/issue-trails/by-pr-ref/[ref]/dismiss-candidates
 *
 * The user reviewed the candidate list and decided none of them are the
 * right match. We mark the candidates dismissed (so the next matcher
 * pass doesn't re-surface them) but leave the PR as 'unmatched' — it
 * stays in the orphan_pr_batch anomaly tally and the user can still
 * link manually later.
 *
 * Body: {} (no parameters)
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  props: { params: Promise<{ ref: string }> },
) {
  const params = await props.params;
  await ensureSchemaAsync();

  const prRef = decodeURIComponent(params.ref);
  if (!prRef.includes('#')) {
    return NextResponse.json(
      { ok: false, error: `Invalid pr_ref: ${prRef}` },
      { status: 400 },
    );
  }

  const db = getLibsqlDb();
  const result = await db
    .prepare(
      `UPDATE orphan_pr_candidates
       SET dismissed_at = datetime('now')
       WHERE pr_ref = ? AND dismissed_at IS NULL`,
    )
    .run(prRef);

  return NextResponse.json({
    ok: true,
    pr_ref: prRef,
    dismissed: result.changes,
  });
}
