import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getProjectSummaryCards } from '@/lib/project-queries';
import { ProjectsIndexClient } from './projects-client';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  await ensureSchemaAsync();
  

  const cards = await getProjectSummaryCards('30d');
  return (
    <WorkspaceModuleGuard module="projects">
      <ProjectsIndexClient initialCards={cards} />
    </WorkspaceModuleGuard>
  );
}
