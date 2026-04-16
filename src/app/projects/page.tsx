import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectSummaryCards } from '@/lib/project-queries';
import { ProjectsIndexClient } from './projects-client';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  initSchema();
  migrateProjectSummaries();

  const cards = getProjectSummaryCards('30d');
  return <ProjectsIndexClient initialCards={cards} />;
}
