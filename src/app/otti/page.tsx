import { initSchema } from '@/lib/schema';
import { initOttiModule } from '@/lib/modules/otti';
import { OttiClient } from './otti-client';
import { WorkspaceModuleGuard } from '@/components/workspace-module-guard';

export const dynamic = 'force-dynamic';

export default function OttiPage() {
  initSchema();
  initOttiModule();

  return (
    <WorkspaceModuleGuard module="otti">
      <OttiClient />
    </WorkspaceModuleGuard>
  );
}
