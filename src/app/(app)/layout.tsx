import { WorkgraphStateProvider } from '@/components/workspace/workgraph-state';
import { WorkspaceAppShell } from '@/components/workspace/workspace-app-shell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkgraphStateProvider>
      <WorkspaceAppShell>{children}</WorkspaceAppShell>
    </WorkgraphStateProvider>
  );
}
