'use client';

import { useEffect, useState } from 'react';
import { Terminal, Copy, Check } from 'lucide-react';
import { toast } from '@/components/shared/toast';

interface AgentStatus {
  paired: boolean;
  online: boolean;
  agentId?: string;
  hostname?: string;
  platform?: string;
  version?: string;
  lastSeenAt?: string;
}

const INSTALL_CMD = 'npm install -g @workgraph/agent';
const PAIR_CMD = 'workgraph login';

/**
 * Settings → AI panel for the local agent. Three states:
 *   1. Not paired      → install instructions + pair-device flow.
 *   2. Paired, offline → hostname + last seen + reconnect hint.
 *   3. Paired, online  → connected indicator + manage/disconnect.
 *
 * The agent itself (the npm package) ships in a follow-up; the pair endpoint
 * is wired to a TODO for now. Once shipped, this card is the only place users
 * interact with the agent from the web UI.
 */
export function LocalAgentCard() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let res: Response;
      try {
        res = await fetch('/api/user/agent-status');
      } catch (err) {
        if (!cancelled) {
          toast.error('Couldn’t reach the agent status API', {
            description: (err as Error).message,
          });
        }
        return;
      }
      if (cancelled) return;
      if (!res.ok) {
        toast.error('Failed to load agent status', {
          description: `HTTP ${res.status} ${res.statusText}`.trim(),
        });
        return;
      }
      const data = (await res.json()) as AgentStatus;
      setStatus(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(cmd);
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500);
    } catch (err) {
      toast.error('Couldn’t copy to clipboard', {
        description:
          (err as Error).message ||
          'Clipboard access requires a secure (https) context. Copy the command manually.',
      });
    }
  };

  const paired = !!status?.paired;
  const online = !!status?.online;
  const badgeBg = paired ? (online ? '#dcfce7' : '#fef3c7') : '#f3f4f6';
  const badgeFg = paired ? (online ? '#166534' : '#92400e') : '#6b7280';
  const badgeLabel = paired ? (online ? 'Connected' : 'Offline') : 'Not paired';

  return (
    <div
      id="agent"
      style={{
        display: 'grid',
        gap: '0.75rem',
        padding: '1rem 1.25rem',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <strong style={{ fontSize: '1rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <Terminal size={14} style={{ display: 'inline' }} aria-hidden />
            Local Agent
          </strong>
          <p style={{ margin: '0.25rem 0 0', color: '#6b7280', fontSize: '0.85rem' }}>
            Run AI on your own machine using your Claude Pro / Codex / Gemini subscriptions. Tasks dispatched
            from this web app execute via your local CLIs — no extra usage on your AI provider key.
          </p>
        </div>
        <span
          style={{
            fontSize: '0.8rem',
            padding: '0.15rem 0.55rem',
            borderRadius: 999,
            background: badgeBg,
            color: badgeFg,
            whiteSpace: 'nowrap',
          }}
        >
          {badgeLabel}
        </span>
      </div>

      {paired && status ? (
        <div
          style={{
            display: 'grid',
            gap: '0.35rem',
            background: '#f9fafb',
            padding: '0.75rem 0.85rem',
            border: '1px solid #f3f4f6',
            borderRadius: 6,
            fontSize: '0.85rem',
          }}
        >
          <div>
            <span style={{ color: '#6b7280' }}>Device: </span>
            <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
              {status.hostname ?? 'unknown'}
              {status.platform ? ` (${status.platform})` : ''}
            </code>
          </div>
          {status.version && (
            <div>
              <span style={{ color: '#6b7280' }}>Version: </span>
              <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{status.version}</code>
            </div>
          )}
          {status.lastSeenAt && (
            <div style={{ color: '#6b7280' }}>Last seen: {status.lastSeenAt}</div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.85rem' }}>
            <span style={{ color: '#374151' }}>1. Install the agent</span>
            <CommandRow cmd={INSTALL_CMD} copied={copied === INSTALL_CMD} onCopy={() => copy(INSTALL_CMD)} />
          </label>

          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.85rem' }}>
            <span style={{ color: '#374151' }}>2. Pair this device</span>
            <CommandRow cmd={PAIR_CMD} copied={copied === PAIR_CMD} onCopy={() => copy(PAIR_CMD)} />
            <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
              The agent prints a 6-character pairing code; confirm it in your browser to link this device.
            </span>
          </label>

          <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
            Already installed and signed in to Claude Code / Codex / Gemini? Just run <code>workgraph login</code>{' '}
            — your existing CLI subscriptions are reused as-is.
          </span>
        </div>
      )}
    </div>
  );
}

function CommandRow({ cmd, copied, onCopy }: { cmd: string; copied: boolean; onCopy: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.4rem',
        alignItems: 'center',
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        padding: '0.4rem 0.5rem 0.4rem 0.65rem',
      }}
    >
      <code
        style={{
          flex: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: '0.85rem',
          color: '#111827',
          background: 'transparent',
        }}
      >
        {cmd}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy"
        aria-label="Copy command"
        style={{
          padding: '0.25rem 0.5rem',
          border: '1px solid #e5e7eb',
          borderRadius: 4,
          background: '#fff',
          cursor: 'pointer',
          fontSize: '0.75rem',
          color: '#374151',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
        }}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
