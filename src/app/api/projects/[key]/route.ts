import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectDetail } from '@/lib/project-queries';
import { getOrGenerateSummary } from '@/lib/project-summary';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

export async function GET(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  initSchema();
  migrateProjectSummaries();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const detail = getProjectDetail(projectKey, period);

  // Generate or fetch cached summary
  const summary = await getOrGenerateSummary(projectKey, projectName);
  detail.health.summary = summary;

  return NextResponse.json(detail);
}
