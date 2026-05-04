import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { UnitEditor } from '@/components/almanac/unit-editor';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function UnitsPage(props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();
  return (
    <WorkspaceModuleGuard module="projects">
      <UnitEditor projectKey={params.key.toUpperCase()} />
    </WorkspaceModuleGuard>
  );
}
