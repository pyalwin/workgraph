import '@/styles/globals.css';
import { AuthKitProvider } from '@workos-inc/authkit-nextjs/components';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { WorkgraphStateProvider } from '@/components/workgraph-state';
import { WorkspaceAppShell } from '@/components/workspace-app-shell';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WorkGraph',
  description: 'Your second brain for work',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const auth = await withAuth();
  const { accessToken, ...initialAuth } = auth;

  return (
    <html lang="en">
      <body>
        <AuthKitProvider initialAuth={initialAuth}>
          <WorkgraphStateProvider>
            <WorkspaceAppShell>{children}</WorkspaceAppShell>
          </WorkgraphStateProvider>
        </AuthKitProvider>
      </body>
    </html>
  );
}
