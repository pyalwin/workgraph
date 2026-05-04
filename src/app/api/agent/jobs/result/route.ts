import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

interface ResultBody {
  job_id: string;
  status: 'done' | 'failed';
  result?: unknown;
  error?: string;
}

interface JobRow {
  agent_id: string;
  status: string;
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  const identity = await verifyAgentRequest(req);
  if (!identity) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body: ResultBody = await req.json();
  if (!body.job_id || !body.status) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (body.status !== 'done' && body.status !== 'failed') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 });
  }

  const db = getLibsqlDb();

  const job = await db
    .prepare(
      `SELECT agent_id, status
       FROM agent_jobs
       WHERE id = ?
       LIMIT 1`,
    )
    .get<JobRow>(body.job_id);

  if (!job || job.agent_id !== identity.agentId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (job.status !== 'running') {
    return NextResponse.json({ error: 'not_running' }, { status: 409 });
  }

  await db
    .prepare(
      `UPDATE agent_jobs
       SET status = ?,
           result = ?,
           error = ?,
           completed_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      body.status,
      JSON.stringify(body.result ?? null),
      body.error ?? null,
      body.job_id,
    );

  return NextResponse.json({ ok: true });
}
