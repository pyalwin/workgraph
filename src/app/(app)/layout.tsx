import { WorkgraphStateProvider } from '@/components/workgraph-state';
import { WorkspaceAppShell } from '@/components/workspace-app-shell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkgraphStateProvider>
      <WorkspaceAppShell>{children}</WorkspaceAppShell>
    </WorkgraphStateProvider>
  );
}
