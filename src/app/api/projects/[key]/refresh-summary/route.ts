import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { forceRegenerateSummary } from '@/lib/project-summary';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

export async function POST(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  initSchema();
  migrateProjectSummaries();

  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const summary = await forceRegenerateSummary(projectKey, projectName);
  return NextResponse.json({ summary });
}
