import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { generateProjectReadme } from '@/lib/sync/project-readme';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  initSchema();

  const projectKey = params.key.toUpperCase();
  const result = await generateProjectReadme(projectKey);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason }, { status: 500 });
  }
  return NextResponse.json({ ok: true, length: result.length });
}
