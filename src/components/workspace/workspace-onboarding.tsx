'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';

export interface WorkspacePreset {
  id: string;
  name: string;
  workflow: string;
  connectors: string[];
}

export const WORKSPACE_PRESETS: WorkspacePreset[] = [
  {
    id: 'engineering',
    name: 'Engineering',
    workflow: 'Idea or issue -> discussion -> plan -> execution -> review -> completion',
    connectors: ['Jira or Linear', 'GitHub or GitLab', 'Slack or Teams', 'Notion, Confluence, or Drive', 'Calendar or meeting tools'],
  },
  {
    id: 'sales',
    name: 'Sales',
    workflow: 'Account signal -> conversation -> commitment -> next step -> close/follow-up',
    connectors: ['Salesforce or HubSpot', 'Gmail or Outlook', 'Slack or Teams', 'Gong or call intelligence', 'Docs or knowledge base'],
  },
  {
    id: 'operations',
    name: 'Operations',
    workflow: 'Signal -> triage -> decision -> process execution -> KPI follow-up',
    connectors: ['Tracker or ticketing system', 'Sheets, warehouse, or BI', 'Gmail or Outlook', 'Slack or Teams', 'Docs or knowledge base'],
  },
  {
    id: 'legal',
    name: 'Legal',
    workflow: 'Request -> matter discussion -> legal position -> document review -> close',
    connectors: ['Matter system', 'Gmail or Outlook', 'Drive, SharePoint, or DMS', 'Slack or Teams', 'Docs or knowledge base'],
  },
  {
    id: 'finance',
    name: 'Finance',
    workflow: 'Variance/control signal -> analysis -> decision -> close action -> audit trail',
    connectors: ['ERP or accounting system', 'Sheets, warehouse, or BI', 'Gmail or Outlook', 'Drive, SharePoint, or DMS', 'Approval tools'],
  },
  {
    id: 'custom-workspace',
    name: 'Custom',
    workflow: 'Signal -> discussion -> decision -> execution -> completion -> follow-up',
    connectors: ['Primary system', 'Slack, Teams, or email', 'Docs or knowledge base', 'Calendar or meeting tools', 'Configured custom tables'],
  },
];

export function WorkspaceOnboarding() {
  const router = useRouter();
  const { setState, refreshWorkspaces } = useWorkgraphState();
  const [selected, setSelected] = useState(WORKSPACE_PRESETS[0].id);
  const [name, setName] = useState(WORKSPACE_PRESETS[0].name);
  const [saving, setSaving] = useState(false);
  const preset = WORKSPACE_PRESETS.find((p) => p.id === selected) ?? WORKSPACE_PRESETS[0];

  const choosePreset = (presetId: string) => {
    const next = WORKSPACE_PRESETS.find((p) => p.id === presetId) ?? WORKSPACE_PRESETS[0];
    setSelected(next.id);
    setName(next.name);
  };

  const create = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, preset: selected }),
      });
      const data = await res.json();
      if (data.workspace) {
        await refreshWorkspaces();
        const role = data.workspace.ui?.roles?.[0];
        setState({
          workspaceId: data.workspace.id,
          role: role?.id || 'owner',
          source: role?.primarySource || 'Primary System',
        });
        router.push('/settings?tab=connectors');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup-shell">
      <section className="setup-hero">
        <div className="setup-kicker">WorkGraph Setup</div>
        <h1>Choose the workspace you want to build first.</h1>
        <p>
          WorkGraph starts from a workflow preset. Each preset controls terminology, menus, roles,
          ontology, and the connector checklist you configure next.
        </p>
      </section>

      <section className="setup-grid">
        <div className="setup-presets">
          {WORKSPACE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`setup-preset ${selected === p.id ? 'on' : ''}`}
              onClick={() => choosePreset(p.id)}
            >
              <span>{p.name}</span>
              <small>{p.workflow}</small>
            </button>
          ))}
        </div>

        <div className="setup-panel">
          <div className="setup-panel-kicker">Selected Workflow</div>
          <h2>{preset.name}</h2>
          <p>{preset.workflow}</p>

          <label className="setup-label">
            Workspace name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="setup-connectors">
            <div className="setup-panel-kicker">Connector Checklist</div>
            {preset.connectors.map((connector) => (
              <div key={connector} className="setup-connector">
                <span />
                {connector}
              </div>
            ))}
          </div>

          <button className="btn btn-primary setup-create" onClick={create} disabled={saving || !name.trim()}>
            {saving ? 'Creating...' : 'Create Workspace'}
          </button>
        </div>
      </section>
    </div>
  );
}
