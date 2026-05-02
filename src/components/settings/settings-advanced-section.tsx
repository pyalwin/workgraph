'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';
import { PipelineKickoffCard } from '@/components/connectors/pipeline-kickoff-card';

const JIRA_PROJECTS = [
  { key: 'ALPHA', name: 'Alpha Initiative' },
  { key: 'BETA', name: 'Beta Platform' },
  { key: 'GAMMA', name: 'Gamma Workflow' },
  { key: 'DELTA', name: 'Delta Services' },
  { key: 'OMEGA', name: 'Omega Operations' },
  { key: 'SIGMA', name: 'Sigma Analytics' },
];

const DATA_SOURCES = [
  { id: 'jira', label: 'Jira' },
  { id: 'slack', label: 'Slack' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'notion', label: 'Notion' },
  { id: 'gmail', label: 'Gmail' },
];

interface Goal {
  id: string;
  name: string;
  description: string;
  keywords: string;
  status: string;
  sort_order: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  preset: string;
  enabled: boolean;
  modules: Record<string, boolean>;
  ui?: {
    menu?: Array<{ id: string; label: string; href: string; module?: string }>;
    roles?: Array<{ id: string; label: string; description?: string; primarySource?: string }>;
    terminology?: Record<string, string>;
  };
  customTables?: Array<{
    id: string;
    label: string;
    module?: string;
    description?: string;
    columns: Array<{ name: string; type: string; required?: boolean; primaryKey?: boolean; indexed?: boolean }>;
  }>;
}

const WORKSPACE_MODULES = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'goals', label: 'Goals' },
];

const PRESETS = [
  { id: 'custom-workspace', label: 'Custom workspace' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'sales', label: 'Sales' },
  { id: 'operations', label: 'Operations' },
  { id: 'legal', label: 'Legal' },
  { id: 'finance', label: 'Finance' },
];

export function SettingsAdvancedSection() {
  const { refreshWorkspaces } = useWorkgraphState();
  const [config, setConfig] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Goal form state
  const [editingGoal, setEditingGoal] = useState<string | null>(null);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [goalForm, setGoalForm] = useState({ name: '', description: '', keywords: '' });
  const [workspaceForm, setWorkspaceForm] = useState({
    name: '',
    preset: 'custom-workspace',
    modules: {
      overview: true,
      projects: false,
      knowledge: true,
      goals: true,
    } as Record<string, boolean>,
  });
  const [tableForm, setTableForm] = useState({
    workspaceId: 'default',
    id: '',
    label: '',
    columns: 'id:text:primary, created_at:datetime:index',
  });

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [syncResult, setSyncResult] = useState<any>(null);

  const fetchSyncStatus = () => {
    fetch('/api/sync')
      .then((r) => r.json())
      .then((data) => setSyncStatus(data))
      .catch(() => {});
  };

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        setConfig(data.config || {});
        setGoals(data.goals || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((data) => setWorkspaces(data.workspaces || []))
      .catch(() => {});
    fetchSyncStatus();
  }, []);

  const createWorkspace = async () => {
    if (!workspaceForm.name.trim()) return;
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workspaceForm),
    });
    const data = await res.json();
    if (data.workspace) {
      setWorkspaces((prev) => [...prev, data.workspace]);
      await refreshWorkspaces();
      setWorkspaceForm((prev) => ({ ...prev, name: '' }));
    }
  };

  const toggleWorkspaceEnabled = async (workspaceId: string, currentEnabled: boolean) => {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !currentEnabled }),
    });
    const data = await res.json();
    if (data.workspace) {
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, enabled: data.workspace.enabled } : w)));
      await refreshWorkspaces();
    }
  };

  const parseTableColumns = () => {
    return tableForm.columns
      .split(',')
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => {
        const [name, type = 'text', ...flags] = raw.split(':').map((part) => part.trim());
        return {
          name,
          type,
          primaryKey: flags.includes('primary'),
          required: flags.includes('required') || flags.includes('primary'),
          indexed: flags.includes('index') || flags.includes('indexed'),
        };
      });
  };

  const createCustomTable = async () => {
    if (!tableForm.workspaceId || !tableForm.id.trim() || !tableForm.label.trim()) return;
    const res = await fetch(`/api/workspaces/${encodeURIComponent(tableForm.workspaceId)}/tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: tableForm.id,
        label: tableForm.label,
        columns: parseTableColumns(),
      }),
    });
    const data = await res.json();
    if (data.workspace) {
      setWorkspaces((prev) => prev.map((workspace) => workspace.id === data.workspace.id ? data.workspace : workspace));
      await refreshWorkspaces();
      setTableForm((prev) => ({ ...prev, id: '', label: '', columns: 'id:text:primary, created_at:datetime:index' }));
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      setSyncResult(data);
      fetchSyncStatus();
    } catch (err: any) {
      setSyncResult({ ok: false, error: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const toggleSource = (sourceId: string) => {
    setConfig((prev: any) => ({
      ...prev,
      sources: {
        ...(prev?.sources || {}),
        [sourceId]: {
          ...(prev?.sources?.[sourceId] || {}),
          enabled: !(prev?.sources?.[sourceId]?.enabled ?? true),
        },
      },
    }));
  };

  const isSourceEnabled = (sourceId: string) => {
    return config?.sources?.[sourceId]?.enabled ?? true;
  };

  const toggleJiraProject = (projectKey: string) => {
    const current: string[] = config?.sources?.jira?.projects || [];
    const updated = current.includes(projectKey)
      ? current.filter((k: string) => k !== projectKey)
      : [...current, projectKey];
    setConfig((prev: any) => ({
      ...prev,
      sources: {
        ...(prev?.sources || {}),
        jira: {
          ...(prev?.sources?.jira || {}),
          projects: updated,
        },
      },
    }));
  };

  const isJiraProjectSelected = (projectKey: string) => {
    const projects: string[] = config?.sources?.jira?.projects || [];
    return projects.includes(projectKey);
  };

  const getSlackMode = () => {
    return config?.sources?.slack?.channelMode || 'all';
  };

  const setSlackMode = (mode: string) => {
    setConfig((prev: any) => ({
      ...prev,
      sources: {
        ...(prev?.sources || {}),
        slack: {
          ...(prev?.sources?.slack || {}),
          channelMode: mode,
        },
      },
    }));
  };

  const parseKeywords = (goal: Goal): string[] => {
    try {
      const parsed = JSON.parse(goal.keywords);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const startEditGoal = (goal: Goal) => {
    setEditingGoal(goal.id);
    setGoalForm({
      name: goal.name,
      description: goal.description || '',
      keywords: parseKeywords(goal).join(', '),
    });
    setShowAddGoal(false);
  };

  const startAddGoal = () => {
    setShowAddGoal(true);
    setEditingGoal(null);
    setGoalForm({ name: '', description: '', keywords: '' });
  };

  const cancelGoalForm = () => {
    setShowAddGoal(false);
    setEditingGoal(null);
    setGoalForm({ name: '', description: '', keywords: '' });
  };

  const saveGoal = async () => {
    const keywords = goalForm.keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (editingGoal) {
      await fetch('/api/config/goals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingGoal, name: goalForm.name, description: goalForm.description, keywords }),
      });
      setGoals((prev) =>
        prev.map((g) =>
          g.id === editingGoal
            ? { ...g, name: goalForm.name, description: goalForm.description, keywords: JSON.stringify(keywords) }
            : g
        )
      );
    } else {
      const res = await fetch('/api/config/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: goalForm.name, description: goalForm.description, keywords }),
      });
      const data = await res.json();
      const newGoal: Goal = {
        id: data.id,
        name: goalForm.name,
        description: goalForm.description,
        keywords: JSON.stringify(keywords),
        status: 'active',
        sort_order: goals.length,
      };
      setGoals((prev) => [...prev, newGoal]);
    }
    cancelGoalForm();
  };

  const deleteGoal = async (goalId: string) => {
    await fetch(`/api/config/goals?id=${goalId}`, { method: 'DELETE' });
    setGoals((prev) => prev.filter((g) => g.id !== goalId));
    if (editingGoal === goalId) cancelGoalForm();
  };

  if (loading) {
    return (
      <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
        <div className="text-[0.82rem] text-[#999]">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Settings</h1>
        <p className="text-[0.82rem] text-[#999]">Configure workspaces, data sources and classification sets</p>
      </div>

      {/* Pipeline kickoff — placed up top because it's the most-clicked admin
          action while testing changes to the matcher / embedding pipeline.
          Configuration sections follow below. */}
      <div className="mb-11">
        <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-4">Pipeline</h2>
        <PipelineKickoffCard />
      </div>

      {/* Workspaces */}
      <div className="mb-11">
        <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-4">Workspaces</h2>
        <Card>
          <CardContent className="pt-[22px]">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-[0.87rem] font-medium text-black tracking-tight">Configured Workspaces</div>
                <div className="text-[0.78rem] text-[#999] mt-[2px] mb-4">
                  Workspaces decide which product modules are visible. Engineering can expose Projects; custom workspaces can expose other modules.
                </div>
                <div className="flex flex-col gap-2">
                  {workspaces.map((workspace) => (
                    <div key={workspace.id} className={`rounded-lg bg-[#fafafa] px-3 py-[10px] ${workspace.enabled === false ? 'opacity-60' : ''}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div>
                            <div className="text-[0.82rem] font-semibold text-black">{workspace.name}</div>
                            <div className="text-[0.67rem] text-[#999] font-mono">{workspace.preset}</div>
                          </div>
                          {workspace.enabled === false && (
                            <Badge variant="outline" className="text-[0.6rem] text-[#999]">Disabled</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex flex-wrap gap-[5px] justify-end">
                            {(workspace.ui?.menu?.length
                              ? workspace.ui.menu
                              : WORKSPACE_MODULES.filter((m) => workspace.modules?.[m.id] !== false).map((m) => ({ ...m, href: '#' }))
                            ).map((module) => (
                              <Badge key={module.id} variant="secondary" className="text-[0.6rem]">
                                {module.label}
                              </Badge>
                            ))}
                          </div>
                          <button
                            onClick={() => toggleWorkspaceEnabled(workspace.id, workspace.enabled !== false)}
                            className={
                              'relative inline-flex h-[22px] w-[40px] items-center rounded-full transition-colors cursor-pointer border-none shrink-0 ' +
                              (workspace.enabled !== false ? 'bg-black' : 'bg-[#ddd]')
                            }
                            title={workspace.enabled !== false ? 'Disable workspace' : 'Enable workspace'}
                          >
                            <span
                              className={
                                'inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform shadow-sm ' +
                                (workspace.enabled !== false ? 'translate-x-[20px]' : 'translate-x-[3px]')
                              }
                            />
                          </button>
                        </div>
                      </div>
                      {!!workspace.ui?.roles?.length && (
                        <div className="mt-3 text-[0.67rem] text-[#999]">
                          Roles: {workspace.ui.roles.map((role) => role.label).join(', ')}
                        </div>
                      )}
                      {!!workspace.customTables?.length && (
                        <div className="mt-3 pt-3 border-t border-black/[0.06]">
                          <div className="text-[0.63rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-2">Tables</div>
                          <div className="flex flex-wrap gap-[5px]">
                            {workspace.customTables.map((table) => (
                              <Badge key={table.id} variant="outline" className="text-[0.6rem]">
                                {table.label}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[0.87rem] font-medium text-black tracking-tight">Add Custom Workspace</div>
                <div className="text-[0.78rem] text-[#999] mt-[2px] mb-4">
                  Start from the generic configurable ontology, then choose visible modules.
                </div>
                <div className="flex flex-col gap-3">
                  <input
                    type="text"
                    placeholder="Workspace name"
                    value={workspaceForm.name}
                    onChange={(e) => setWorkspaceForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                  />
                  <select
                    value={workspaceForm.preset}
                    onChange={(e) => setWorkspaceForm((prev) => ({ ...prev, preset: e.target.value }))}
                    className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] outline-none focus:border-black/20 transition-colors bg-white"
                  >
                    {PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    {WORKSPACE_MODULES.map((module) => (
                      <label key={module.id} className="flex items-center gap-[8px] py-[5px] px-[6px] rounded-lg cursor-pointer hover:bg-[#f5f5f5] transition-all">
                        <input
                          type="checkbox"
                          checked={workspaceForm.modules[module.id] ?? false}
                          onChange={() => setWorkspaceForm((prev) => ({
                            ...prev,
                            modules: {
                              ...prev.modules,
                              [module.id]: !(prev.modules[module.id] ?? false),
                            },
                          }))}
                          className="w-[14px] h-[14px] accent-black cursor-pointer"
                        />
                        <span className="text-[0.78rem] text-[#333]">{module.label}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={createWorkspace}
                    disabled={!workspaceForm.name.trim()}
                    className="bg-black text-white rounded-lg px-5 py-[7px] text-[0.82rem] font-medium border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Add Workspace
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-6 pt-6 border-t border-black/[0.07]">
              <div className="text-[0.87rem] font-medium text-black tracking-tight">Add Custom Table</div>
              <div className="text-[0.78rem] text-[#999] mt-[2px] mb-4">
                Define workspace-specific datasets without adding them to the core schema. Column format: <span className="font-mono">name:type:flags</span>, comma-separated. Types: text, integer, real, datetime, json, boolean. Flags: primary, required, index.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <select
                  value={tableForm.workspaceId}
                  onChange={(e) => setTableForm((prev) => ({ ...prev, workspaceId: e.target.value }))}
                  className="px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] outline-none focus:border-black/20 transition-colors bg-white"
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="table_id"
                  value={tableForm.id}
                  onChange={(e) => setTableForm((prev) => ({ ...prev, id: e.target.value }))}
                  className="px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                />
                <input
                  type="text"
                  placeholder="Table label"
                  value={tableForm.label}
                  onChange={(e) => setTableForm((prev) => ({ ...prev, label: e.target.value }))}
                  className="px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                />
                <button
                  onClick={createCustomTable}
                  disabled={!tableForm.workspaceId || !tableForm.id.trim() || !tableForm.label.trim()}
                  className="bg-black text-white rounded-lg px-5 py-[7px] text-[0.82rem] font-medium border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create Table
                </button>
              </div>
              <input
                type="text"
                value={tableForm.columns}
                onChange={(e) => setTableForm((prev) => ({ ...prev, columns: e.target.value }))}
                className="mt-3 w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white font-mono"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sync */}
      <div className="mb-11">
        <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-4">Sync</h2>
        <Card>
          <CardContent className="pt-[22px]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-[0.87rem] font-medium text-black tracking-tight">Run Sync</div>
                <div className="text-[0.78rem] text-[#999] mt-[2px]">
                  Re-classify all items, create cross-references, and compute metrics
                </div>
              </div>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="bg-black text-white rounded-lg px-5 py-[7px] text-[0.82rem] font-medium border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>

            {/* Sync Result */}
            {syncResult && (
              <div className={
                'rounded-lg px-4 py-3 mb-4 text-[0.78rem] ' +
                (syncResult.ok
                  ? 'bg-[rgba(26,135,84,0.06)] text-[#1a8754]'
                  : 'bg-[rgba(197,48,48,0.06)] text-[#c53030]')
              }>
                {syncResult.ok ? (
                  <div>
                    <div className="font-medium mb-2">Sync complete</div>

                    {/* Ingestion summary */}
                    {(syncResult.meetingsIngested > 0 || syncResult.meetingsSkipped > 0) && (
                      <div className="text-[0.72rem] opacity-80 mb-2">
                        Meetings: {syncResult.meetingsIngested > 0 ? `${syncResult.meetingsIngested} new` : ''}
                        {syncResult.meetingsIngested > 0 && syncResult.meetingsSkipped > 0 ? ', ' : ''}
                        {syncResult.meetingsSkipped > 0 ? `${syncResult.meetingsSkipped} unchanged` : ''}
                      </div>
                    )}

                    {/* Source breakdown */}
                    {syncResult.breakdown && (
                      <div className="flex gap-3 mb-2 text-[0.72rem] opacity-80">
                        {Object.entries(syncResult.breakdown).map(([source, count]: [string, any]) => (
                          count > 0 && (
                            <span key={source}>
                              <span className="font-semibold">{count}</span> {source === 'meeting' ? 'meetings' : source}
                            </span>
                          )
                        ))}
                      </div>
                    )}

                    {/* Goal classification */}
                    {syncResult.goalStats && syncResult.goalStats.length > 0 && (
                      <div className="text-[0.72rem] opacity-80 mb-1">
                        <span className="font-medium">Classified to goals: </span>
                        {syncResult.goalStats
                          .filter((g: any) => g.item_count > 0)
                          .map((g: any) => `${g.name} (${g.item_count})`)
                          .join(', ') || 'No items matched goals'}
                      </div>
                    )}

                    <div className="text-[0.72rem] opacity-80 mt-1">
                      {syncResult.totalItems} total items · {syncResult.totalLinks} cross-references
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="font-medium">Sync failed</div>
                    <div className="text-[0.72rem] opacity-80">{syncResult.error}</div>
                  </div>
                )}
              </div>
            )}

            {/* Sync Status per source */}
            {syncStatus && (
              <div className="border-t border-black/[0.07] pt-4">
                <div className="text-[0.72rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-3">Current Data</div>
                <div className="grid grid-cols-5 gap-3">
                  {Object.entries(syncStatus.sources || {}).map(([source, info]: [string, any]) => (
                    <div key={source} className="rounded-lg bg-[#fafafa] px-3 py-[10px]">
                      <div className="text-[0.72rem] font-medium text-[#999] capitalize">{source === 'meeting' ? 'Meetings' : source}</div>
                      <div className="text-[1rem] font-bold text-black tabular-nums mt-[2px]">{info.count}</div>
                      <div className="text-[0.63rem] text-[#bbb] mt-[2px]">
                        {info.lastSync
                          ? `Last: ${new Date(info.lastSync).toLocaleDateString()}`
                          : 'Never synced'}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-4 mt-3 text-[0.72rem] text-[#999]">
                  <span><span className="font-semibold text-[#333] tabular-nums">{syncStatus.totalItems}</span> total items</span>
                  <span><span className="font-semibold text-[#333] tabular-nums">{syncStatus.totalVersions}</span> versions tracked</span>
                  <span><span className="font-semibold text-[#333] tabular-nums">{syncStatus.totalLinks}</span> cross-references</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Data Sources */}
      <div className="mb-11">
        <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-4">Data Sources</h2>
        <div className="flex flex-col gap-[10px]">
          {DATA_SOURCES.map((source) => (
            <Card key={source.id}>
              <CardContent className="pt-[22px]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-[0.87rem] font-medium text-black tracking-tight">{source.label}</span>
                  </div>
                  <button
                    onClick={() => toggleSource(source.id)}
                    className={
                      'relative inline-flex h-[22px] w-[40px] items-center rounded-full transition-colors cursor-pointer border-none ' +
                      (isSourceEnabled(source.id) ? 'bg-black' : 'bg-[#ddd]')
                    }
                  >
                    <span
                      className={
                        'inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform shadow-sm ' +
                        (isSourceEnabled(source.id) ? 'translate-x-[20px]' : 'translate-x-[3px]')
                      }
                    />
                  </button>
                </div>

                {/* Jira: project selection */}
                {source.id === 'jira' && isSourceEnabled('jira') && (
                  <div className="mt-4 pt-4 border-t border-black/[0.07]">
                    <CardTitle className="mb-3">Jira Projects</CardTitle>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-[6px]">
                      {JIRA_PROJECTS.map((project) => (
                        <label
                          key={project.key}
                          className="flex items-center gap-[8px] py-[5px] px-[6px] rounded-lg cursor-pointer hover:bg-[#f5f5f5] transition-all"
                        >
                          <input
                            type="checkbox"
                            checked={isJiraProjectSelected(project.key)}
                            onChange={() => toggleJiraProject(project.key)}
                            className="w-[14px] h-[14px] accent-black cursor-pointer"
                          />
                          <span className="text-[0.78rem] text-[#333]">
                            <span className="font-medium text-black">{project.key}</span>
                            <span className="text-[#999] ml-[6px]">{project.name}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Slack: channel mode */}
                {source.id === 'slack' && isSourceEnabled('slack') && (
                  <div className="mt-4 pt-4 border-t border-black/[0.07]">
                    <CardTitle className="mb-3">Channel Scope</CardTitle>
                    <div className="flex flex-col gap-[6px]">
                      <label className="flex items-center gap-[8px] py-[5px] px-[6px] rounded-lg cursor-pointer hover:bg-[#f5f5f5] transition-all">
                        <input
                          type="radio"
                          name="slack-mode"
                          checked={getSlackMode() === 'all'}
                          onChange={() => setSlackMode('all')}
                          className="w-[14px] h-[14px] accent-black cursor-pointer"
                        />
                        <span className="text-[0.78rem] text-[#333]">All channels</span>
                      </label>
                      <label className="flex items-center gap-[8px] py-[5px] px-[6px] rounded-lg cursor-pointer hover:bg-[#f5f5f5] transition-all">
                        <input
                          type="radio"
                          name="slack-mode"
                          checked={getSlackMode() === 'selected'}
                          onChange={() => setSlackMode('selected')}
                          className="w-[14px] h-[14px] accent-black cursor-pointer"
                        />
                        <span className="text-[0.78rem] text-[#333]">Selected channels</span>
                      </label>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Strategic Goals */}
      <div className="mb-11">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999]">Strategic Goals</h2>
          <button
            onClick={startAddGoal}
            className="px-[10px] py-[5px] rounded-[6px] text-[0.78rem] font-medium text-black bg-white border border-black/[0.07] cursor-pointer hover:bg-[#f5f5f5] transition-all"
          >
            + Add Goal
          </button>
        </div>

        <div className="flex flex-col gap-[10px]">
          {/* Add Goal form */}
          {showAddGoal && (
            <Card>
              <CardContent className="pt-[22px]">
                <CardTitle className="mb-3">New Goal</CardTitle>
                <div className="flex flex-col gap-3">
                  <input
                    type="text"
                    placeholder="Goal name"
                    value={goalForm.name}
                    onChange={(e) => setGoalForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                  />
                  <input
                    type="text"
                    placeholder="Description"
                    value={goalForm.description}
                    onChange={(e) => setGoalForm((f) => ({ ...f, description: e.target.value }))}
                    className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                  />
                  <input
                    type="text"
                    placeholder="Keywords (comma-separated)"
                    value={goalForm.keywords}
                    onChange={(e) => setGoalForm((f) => ({ ...f, keywords: e.target.value }))}
                    className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={cancelGoalForm}
                      className="px-[10px] py-[5px] rounded-[6px] text-[0.78rem] text-[#999] bg-transparent border-none cursor-pointer hover:text-[#333] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveGoal}
                      disabled={!goalForm.name.trim()}
                      className="px-[14px] py-[5px] rounded-[6px] text-[0.78rem] font-medium text-white bg-black border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Goal list */}
          {goals.map((goal) => (
            <Card key={goal.id}>
              <CardContent className="pt-[22px]">
                {editingGoal === goal.id ? (
                  <div className="flex flex-col gap-3">
                    <input
                      type="text"
                      placeholder="Goal name"
                      value={goalForm.name}
                      onChange={(e) => setGoalForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                    />
                    <input
                      type="text"
                      placeholder="Description"
                      value={goalForm.description}
                      onChange={(e) => setGoalForm((f) => ({ ...f, description: e.target.value }))}
                      className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                    />
                    <input
                      type="text"
                      placeholder="Keywords (comma-separated)"
                      value={goalForm.keywords}
                      onChange={(e) => setGoalForm((f) => ({ ...f, keywords: e.target.value }))}
                      className="w-full px-3 py-[7px] rounded-lg border border-black/[0.07] text-[0.82rem] text-[#333] placeholder:text-[#bbb] outline-none focus:border-black/20 transition-colors bg-white"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={cancelGoalForm}
                        className="px-[10px] py-[5px] rounded-[6px] text-[0.78rem] text-[#999] bg-transparent border-none cursor-pointer hover:text-[#333] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveGoal}
                        disabled={!goalForm.name.trim()}
                        className="px-[14px] py-[5px] rounded-[6px] text-[0.78rem] font-medium text-white bg-black border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-[0.87rem] font-medium text-black tracking-tight">{goal.name}</div>
                      {goal.description && (
                        <div className="text-[0.78rem] text-[#999] mt-[2px]">{goal.description}</div>
                      )}
                      {parseKeywords(goal).length > 0 && (
                        <div className="flex flex-wrap gap-[5px] mt-[8px]">
                          {parseKeywords(goal).map((kw) => (
                            <Badge key={kw} variant="secondary" className="text-[0.63rem]">
                              {kw}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-[2px] shrink-0">
                      <button
                        onClick={() => startEditGoal(goal)}
                        className="px-[8px] py-[4px] rounded-[6px] text-[0.72rem] text-[#999] bg-transparent border-none cursor-pointer hover:text-[#333] hover:bg-[#f5f5f5] transition-all"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteGoal(goal.id)}
                        className="px-[8px] py-[4px] rounded-[6px] text-[0.72rem] text-[#999] bg-transparent border-none cursor-pointer hover:text-[#c53030] hover:bg-[rgba(197,48,48,0.08)] transition-all"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {goals.length === 0 && !showAddGoal && (
            <div className="text-[0.82rem] text-[#999] py-4 text-center">
              No goals configured yet. Click &quot;Add Goal&quot; to create one.
            </div>
          )}
        </div>
      </div>

      {/* Save Button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-black text-white rounded-lg px-6 py-2 text-[0.82rem] font-medium border-none cursor-pointer hover:bg-[#333] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {saved && (
          <span className="text-[0.78rem] text-[#1a8754] font-medium">Settings saved</span>
        )}
      </div>
    </div>
  );
}
