import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { forceRegenerateSummary } from '@/lib/project-summary';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  ALPHA: 'Alpha Initiative',
  BETA: 'Beta Platform',
  GAMMA: 'Gamma Workflow',
};

export async function POST(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();
  

  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const summary = await forceRegenerateSummary(projectKey, projectName);
  return NextResponse.json({ summary });
}
