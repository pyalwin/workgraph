'use client';

import { ReactNode } from 'react';
import { AgentInstallNudge } from '@/components/workspace/agent-install-nudge';
import { Capture } from '@/components/chat/capture';
import { SuggestedConnectorsBanner } from '@/components/connectors/suggested-connectors-banner';
import { Toaster } from '@/components/shared/toast';
import { Topbar } from '@/components/layout/topbar';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';
import { WorkspaceOnboarding } from '@/components/workspace/workspace-onboarding';

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
      <AgentInstallNudge />
      <SuggestedConnectorsBanner />
      <main>{children}</main>
      <Capture />
      <Toaster />
    </>
  );
}
