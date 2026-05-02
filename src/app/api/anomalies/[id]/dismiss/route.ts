/**
 * Mark an anomaly as dismissed_by_user. The user has reviewed it and decided
 * no follow-up is needed. The next anomaly scan won't re-create it because
 * the upsert keys on (workspace_id, scope, kind) and won't reset
 * dismissed_by_user.
 *
 * Body: { handled_note?: string }
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { loadAnomaly, markAnomalyHandled } from '@/lib/anomaly-actions';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  await ensureSchemaAsync();

  const anomaly = await loadAnomaly(params.id);
  if (!anomaly) {
    return NextResponse.json({ ok: false, error: 'Anomaly not found' }, { status: 404 });
  }

  let handledNote: string | null = null;
  try {
    const body = (await req.json()) as { handled_note?: unknown };
    if (typeof body.handled_note === 'string' && body.handled_note.trim()) {
      handledNote = body.handled_note.trim();
    }
  } catch {
    // empty/invalid body is fine — dismiss has no required fields
  }

  await markAnomalyHandled(anomaly.id, {
    handled_note: handledNote,
    dismiss: true,
  });
  return NextResponse.json({ ok: true });
}
