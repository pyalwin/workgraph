'use client';

import Link from 'next/link';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';

export function WorkspaceModuleGuard({
  module,
  children,
}: {
  module: string;
  children: React.ReactNode;
}) {
  const { activeWorkspace } = useWorkgraphState();
  const enabled = activeWorkspace.modules?.[module] !== false;
  if (enabled) return <>{children}</>;

  return (
    <div className="page">
      <section className="empty-state">
        <div className="empty-title">Module not enabled for {activeWorkspace.name}</div>
        <div className="empty-copy">
          Switch workspaces from the top bar, or enable this module from Settings.
        </div>
        <Link className="btn btn-primary" href="/settings">
          Open Settings
        </Link>
      </section>
    </div>
  );
}
