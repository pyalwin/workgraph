import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { AlmanacDocClient } from './almanac-doc-client';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default async function AlmanacDocPage(
  props: { params: Promise<{ key: string; doc_id: string }> }
) {
  const params = await props.params;
  await ensureSchemaAsync();

  return (
    <WorkspaceModuleGuard module="projects">
      <AlmanacDocClient
        projectKey={params.key.toUpperCase()}
        docId={params.doc_id}
      />
    </WorkspaceModuleGuard>
  );
}
