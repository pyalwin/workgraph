import '@/styles/globals.css';
import { WorkgraphStateProvider } from '@/components/workgraph-state';
import { WorkspaceAppShell } from '@/components/workspace-app-shell';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WorkGraph',
  description: 'Your second brain for work',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WorkgraphStateProvider>
          <WorkspaceAppShell>{children}</WorkspaceAppShell>
        </WorkgraphStateProvider>
      </body>
    </html>
  );
}
