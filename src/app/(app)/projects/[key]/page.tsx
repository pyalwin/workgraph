import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { ProjectDetailClient } from './project-detail-client';
import { WorkspaceModuleGuard } from '@/components/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage(props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  initSchema();
  migrateProjectSummaries();

  return (
    <WorkspaceModuleGuard module="projects">
      <ProjectDetailClient projectKey={params.key.toUpperCase()} />
    </WorkspaceModuleGuard>
  );
}
