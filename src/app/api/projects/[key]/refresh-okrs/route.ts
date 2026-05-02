import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { generateProjectOKRs } from '@/lib/sync/project-okrs';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();

  const projectKey = params.key.toUpperCase();
  const result = await generateProjectOKRs(projectKey);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason }, { status: 500 });
  }
  return NextResponse.json({ ok: true, objectives: result.objectives, keyResults: result.keyResults });
}
