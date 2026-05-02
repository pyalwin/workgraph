'use client';

import { useEffect, useState } from 'react';

interface TaskRow {
  task: string;
  backend_id: string;
  is_default: boolean;
}

interface BackendOpt {
  id: string;
  label: string;
  available: boolean;
}

const TASK_LABELS: Record<string, { label: string; hint: string }> = {
  enrich: { label: 'Enrich', hint: 'Per-item AI summary on sync (high volume)' },
  recap: { label: 'Recap', hint: 'Project recap blurbs' },
  extract: { label: 'Extract', hint: 'Decision / entity extraction' },
  'project-summary': { label: 'Project summary', hint: 'Project health summaries' },
  decision: { label: 'Decision summary', hint: 'PR-review decision rationale' },
  narrative: { label: 'Narrative', hint: 'Workstream / project README narrative' },
  chat: { label: 'Chat', hint: 'Workgraph chat (the chat UI also has its own picker)' },
};

export function AITaskBackendsSection() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [backends, setBackends] = useState<BackendOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTask, setSavingTask] = useState<string | null>(null);
  const [status, setStatus] = useState<{ task: string; tone: 'ok' | 'err'; msg: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/task-backends');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setTasks(j.tasks);
      setBackends(j.backends);
    } catch (err) {
      setStatus({ task: '*', tone: 'err', msg: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onChange = async (task: string, value: string) => {
    setSavingTask(task);
    try {
      const res = await fetch('/api/ai/task-backends', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task, backend: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus({ task, tone: 'ok', msg: 'Saved' });
      await load();
    } catch (err) {
      setStatus({ task, tone: 'err', msg: (err as Error).message });
    } finally {
      setSavingTask(null);
      setTimeout(() => setStatus(null), 1800);
    }
  };

  return (
    <div className="ai-task-backends">
      <div className="ai-task-backends-head">
        <h3>Task routing</h3>
        <p>Pick which backend handles each AI workflow. Defaults to Vercel AI SDK.</p>
      </div>
      {loading ? (
        <p className="ai-task-loading">Loading…</p>
      ) : (
        <div className="ai-task-list">
          {tasks.map((t) => {
            const meta = TASK_LABELS[t.task] ?? { label: t.task, hint: '' };
            const value = t.is_default ? 'default' : t.backend_id;
            return (
              <div key={t.task} className="ai-task-row">
                <div className="ai-task-info">
                  <div className="ai-task-name">{meta.label}</div>
                  {meta.hint && <div className="ai-task-hint">{meta.hint}</div>}
                </div>
                <div className="ai-task-control">
                  <select
                    value={value}
                    disabled={savingTask === t.task}
                    onChange={(e) => onChange(t.task, e.target.value)}
                  >
                    <option value="default">Default (Vercel AI SDK)</option>
                    {backends.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.available}>
                        {b.label}
                        {!b.available ? ' (not installed)' : ''}
                      </option>
                    ))}
                  </select>
                  {status?.task === t.task && (
                    <span className={`ai-task-status ai-task-status-${status.tone}`}>
                      {status.msg}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
