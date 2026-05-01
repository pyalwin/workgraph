'use client';

import { ReactNode } from 'react';
import { Capture } from '@/components/capture';
import { SuggestedConnectorsBanner } from '@/components/suggested-connectors-banner';
import { Topbar } from '@/components/topbar';
import { useWorkgraphState } from '@/components/workgraph-state';
import { WorkspaceOnboarding } from '@/components/workspace-onboarding';

export function WorkspaceAppShell({ children }: { children: ReactNode }) {
  const { loadingWorkspaces, setupComplete } = useWorkgraphState();

  if (loadingWorkspaces) {
    return <div className="setup-loading">Loading WorkGraph...</div>;
  }

  if (!setupComplete) {
    return <WorkspaceOnboarding />;
  }

  return (
    <>
      <Topbar />
      <SuggestedConnectorsBanner />
      <main>{children}</main>
      <Capture />
    </>
  );
}
