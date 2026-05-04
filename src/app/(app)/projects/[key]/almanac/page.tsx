import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { AlmanacClient } from './almanac-client';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function AlmanacPage(props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();
  return (
    <WorkspaceModuleGuard module="projects">
      <AlmanacClient projectKey={params.key.toUpperCase()} />
    </WorkspaceModuleGuard>
  );
}
