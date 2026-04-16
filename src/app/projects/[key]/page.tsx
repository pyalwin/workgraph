import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { ProjectDetailClient } from './project-detail-client';

export const dynamic = 'force-dynamic';

export default function ProjectDetailPage({ params }: { params: { key: string } }) {
  initSchema();
  migrateProjectSummaries();

  return <ProjectDetailClient projectKey={params.key.toUpperCase()} />;
}
