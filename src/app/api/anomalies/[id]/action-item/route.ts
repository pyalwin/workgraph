/**
 * Convert an open anomaly into a tracked action item, anchored to the
 * project hub work_item so it surfaces in the project's Actions tab next
 * to the AI-generated items.
 *
 * Body: { text: string; assignee?: string; user_priority?: 'p0'|'p1'|'p2'|'p3';
 *         due_at?: string; dismiss?: boolean; handled_note?: string }
 */
import { NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  loadAnomaly,
  resolveProjectKeyForAnomaly,
  resolveProjectHubId,
  markAnomalyHandled,
} from '@/lib/anomaly-actions';

export const dynamic = 'force-dynamic';

const ALLOWED_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);

interface Body {
  text?: unknown;
  assignee?: unknown;
  user_priority?: unknown;
  due_at?: unknown;
  dismiss?: unknown;
  handled_note?: unknown;
}

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
  if (anomaly.handled_at) {
    // Idempotent re-clicks: surface the prior result rather than duplicating.
    return NextResponse.json({
      ok: true,
      already_handled: true,
      action_item_id: anomaly.action_item_id,
      jira_issue_key: anomaly.jira_issue_key,
    });
  }

  const projectKey = await resolveProjectKeyForAnomaly(anomaly);
  if (!projectKey) {
    return NextResponse.json(
      { ok: false, error: 'Could not resolve project for this anomaly' },
      { status: 400 },
    );
  }
  const hubId = await resolveProjectHubId(projectKey);
  if (!hubId) {
    return NextResponse.json(
      { ok: false, error: `Project hub work_item missing for ${projectKey}` },
      { status: 400 },
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  }
  const assignee = typeof body.assignee === 'string' && body.assignee.trim() ? body.assignee.trim() : null;
  const dueAt = typeof body.due_at === 'string' && body.due_at.trim() ? body.due_at.trim() : null;
  const userPriorityRaw = typeof body.user_priority === 'string' ? body.user_priority.toLowerCase() : '';
  const userPriority = ALLOWED_PRIORITIES.has(userPriorityRaw) ? userPriorityRaw : null;
  const dismiss = body.dismiss === true;
  const handledNote = typeof body.handled_note === 'string' && body.handled_note.trim()
    ? body.handled_note.trim()
    : null;

  const db = getLibsqlDb();
  const actionItemId = uuid();
  await db
    .prepare(
      `INSERT INTO action_items (id, source_item_id, text, assignee, due_at, user_priority, ai_priority, state)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'open')`,
    )
    .run(actionItemId, hubId, text, assignee, dueAt, userPriority);

  await markAnomalyHandled(anomaly.id, {
    action_item_id: actionItemId,
    handled_note: handledNote,
    dismiss,
  });

  return NextResponse.json({
    ok: true,
    action_item_id: actionItemId,
    project_key: projectKey,
    dismissed: dismiss,
  });
}
