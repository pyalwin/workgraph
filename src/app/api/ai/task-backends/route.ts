import { NextRequest, NextResponse } from 'next/server';
import {
  ALL_TASKS,
  clearTaskBackend,
  listTaskBackends,
  setTaskBackend,
} from '@/lib/ai/task-backend-store';
import { listAvailableBackends } from '@/lib/ai/cli-backends';
import { getActiveWorkspaceId } from '@/lib/active-workspace';
import type { AITask } from '@/lib/ai';
import type { BackendId } from '@/lib/ai/cli-backends';

export const dynamic = 'force-dynamic';

export async function GET() {
  const stored = await listTaskBackends();
  // Pass workspace context so the Local Agent option reflects paired-agent
  // heartbeat. Without this, the option always reports "no agent paired"
  // even when one is alive.
  const workspaceId = await getActiveWorkspaceId().catch(() => undefined);
  const backends = await listAvailableBackends(workspaceId);
  const map = new Map(stored.map((r) => [r.task, r.backend_id]));
  const tasks = ALL_TASKS.map((t) => ({
    task: t,
    backend_id: map.get(t) ?? 'sdk',
    is_default: !map.has(t),
  }));
  return NextResponse.json({ tasks, backends });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { task?: AITask; backend?: BackendId | 'default' }
    | null;
  if (!body?.task || !body.backend) {
    return NextResponse.json({ error: 'task and backend required' }, { status: 400 });
  }
  try {
    if (body.backend === 'default') {
      await clearTaskBackend(body.task);
    } else {
      await setTaskBackend(body.task, body.backend);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
