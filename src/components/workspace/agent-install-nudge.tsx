'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { toast } from '@/components/shared/toast';

const DISMISS_KEY = 'agent_install_nudge';

interface AgentStatus {
  paired: boolean;
  online: boolean;
}

/**
 * Surfaces the local-agent install option once per user, dismissible forever.
 *
 * Hidden when:
 *   - the user has already dismissed it (server-side, follows them across devices)
 *   - the user has paired any local agent (no need to nudge what's already done)
 *
 * Settings UI also exposes the same install/pair flow without the nudge —
 * this banner is just for first-time discovery.
 */
export function AgentInstallNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [dRes, aRes] = await Promise.all([
        fetch(`/api/user/dismissals?key=${DISMISS_KEY}`).catch((err: Error) => err),
        fetch('/api/user/agent-status').catch((err: Error) => err),
      ]);
      if (cancelled) return;
      // Network errors (offline, transient): stay silent — surfacing the
      // nudge spuriously is worse than missing one. Only surface non-OK
      // HTTP responses, and only as a low-noise info toast.
      if (dRes instanceof Error || aRes instanceof Error) return;
      if (!dRes.ok || !aRes.ok) {
        toast.warning('Could not check agent status', {
          description: 'Some Settings → AI features may be temporarily unavailable.',
        });
        return;
      }
      const dismissed = !!(await dRes.json()).dismissed;
      const agent: AgentStatus = await aRes.json();
      setShow(!dismissed && !agent.paired);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  const dismiss = async () => {
    setShow(false);
    try {
      const res = await fetch('/api/user/dismissals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: DISMISS_KEY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Banner is hidden for this session, but the dismissal didn't reach
      // the server — it'll come back on next reload. Tell the user.
      toast.warning('Couldn’t save your dismissal', {
        description: (err as Error).message,
      });
    }
  };

  return (
    <div className="suggested-banner" role="status">
      <div className="suggested-banner-icon">
        <Sparkles className="w-4 h-4" />
      </div>
      <div className="suggested-banner-body">
        <div className="suggested-banner-title">
          Use your own Claude / Codex / Gemini subscriptions
        </div>
        <div className="suggested-banner-sub">
          Install the WorkGraph Agent to run AI on your machine — no extra usage on your AI provider key.
        </div>
      </div>
      <Link href="/settings?tab=ai#agent" className="btn btn-primary btn-sm">
        Set up
      </Link>
      <button
        type="button"
        className="suggested-banner-dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
