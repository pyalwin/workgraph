import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { ProjectDetailClient } from './project-detail-client';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage(props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();
  

  return (
    <WorkspaceModuleGuard module="projects">
      <ProjectDetailClient projectKey={params.key.toUpperCase()} />
    </WorkspaceModuleGuard>
  );
}
