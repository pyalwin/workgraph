'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const JIRA_PROJECTS = [
  { key: 'APPA', name: 'Accounts Payable Automation' },
  { key: 'CAP', name: 'Instant Capture' },
  { key: 'COPILOT', name: 'Otti Copilot' },
  { key: 'COT', name: 'Customer Onboarding Tools' },
  { key: 'DAT', name: 'Data' },
  { key: 'DEV', name: 'DevOps' },
  { key: 'EDI', name: 'EDI' },
  { key: 'INT', name: 'Integrations' },
  { key: 'IV', name: 'Item Validation' },
  { key: 'OA', name: 'Otti Assistant' },
  { key: 'OPS', name: 'Operations' },
  { key: 'PAY', name: 'Payments' },
  { key: 'PEX', name: 'Partner Experience' },
  { key: 'PLAT', name: 'Platform' },
  { key: 'PROD', name: 'Product' },
  { key: 'QA', name: 'QA' },
  { key: 'REP', name: 'Reports' },
  { key: 'SEC', name: 'Security' },
  { key: 'SMP', name: 'Spend Management' },
  { key: 'TOOL', name: 'Internal Tools' },
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

export default function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Goal form state
  const [editingGoal, setEditingGoal] = useState<string | null>(null);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [goalForm, setGoalForm] = useState({ name: '', description: '', keywords: '' });

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        setConfig(data.config || {});
        setGoals(data.goals || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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

  const saveGoal = () => {
    const keywords = goalForm.keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (editingGoal) {
      setGoals((prev) =>
        prev.map((g) =>
          g.id === editingGoal
            ? { ...g, name: goalForm.name, description: goalForm.description, keywords: JSON.stringify(keywords) }
            : g
        )
      );
    } else {
      const newGoal: Goal = {
        id: `goal_${Date.now()}`,
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

  const deleteGoal = (goalId: string) => {
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
        <p className="text-[0.82rem] text-[#999]">Configure data sources and strategic goals</p>
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
