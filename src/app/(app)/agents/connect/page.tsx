'use client';

/**
 * /agents/connect
 *
 * Agent pairing confirmation page. The user runs `workgraph login` on their
 * local machine, which prints a 6-char user_code and this URL. They open the
 * URL, type the code here, and click Connect. That triggers
 * POST /api/agent/pair/confirm which creates the agents row and unblocks the
 * CLI's poll loop.
 *
 * The URL may pre-fill the code via ?code=... so the user can just click
 * "Connect" without typing.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

type State = 'idle' | 'submitting' | 'success' | 'error';

export default function AgentsConnectPage() {
  const searchParams = useSearchParams();
  const prefillCode = searchParams.get('code') ?? '';

  const [code, setCode] = useState(prefillCode.toUpperCase());
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // If the URL has the code, auto-focus the button so the user just presses Enter.
  useEffect(() => {
    if (prefillCode) {
      setCode(prefillCode.toUpperCase());
    }
  }, [prefillCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    setState('submitting');
    setErrorMsg('');

    try {
      const res = await fetch('/api/agent/pair/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: trimmed }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? 'Something went wrong. Please try again.');
        setState('error');
        return;
      }

      setState('success');
    } catch {
      setErrorMsg('Network error — check your connection and try again.');
      setState('error');
    }
  };

  if (state === 'success') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.successIcon}>✓</div>
          <h1 style={styles.heading}>Agent connected</h1>
          <p style={styles.body}>
            Your local agent is now paired with this workspace. You can close this
            tab and return to your terminal — the agent will start processing jobs
            automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.heading}>Connect your local agent</h1>
        <p style={styles.body}>
          Enter the 6-character code displayed in your terminal after running{' '}
          <code style={styles.code}>workgraph login</code>.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="user_code" style={styles.label}>
            Pairing code
          </label>
          <input
            id="user_code"
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
            }}
            placeholder="XXXXXX"
            autoFocus={!prefillCode}
            maxLength={6}
            required
            disabled={state === 'submitting'}
            style={styles.input}
          />

          {state === 'error' && (
            <div style={styles.errorBox}>{errorMsg}</div>
          )}

          <button
            type="submit"
            disabled={state === 'submitting' || code.trim().length < 6}
            style={{
              ...styles.button,
              opacity: state === 'submitting' || code.trim().length < 6 ? 0.55 : 1,
            }}
          >
            {state === 'submitting' ? 'Connecting…' : 'Connect agent'}
          </button>
        </form>

        <p style={styles.hint}>
          The code expires in 10 minutes. If it has expired, re-run{' '}
          <code style={styles.code}>workgraph login</code> to get a new one.
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px 20px',
    background: 'var(--bone)',
  } as React.CSSProperties,

  card: {
    background: 'var(--paper)',
    border: '1px solid var(--rule-2)',
    borderRadius: 14,
    padding: '40px 44px',
    maxWidth: 420,
    width: '100%',
    boxShadow: '0 2px 16px rgba(21,20,15,0.06)',
  } as React.CSSProperties,

  heading: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--ink)',
    marginBottom: 12,
    letterSpacing: '-0.01em',
  } as React.CSSProperties,

  body: {
    fontSize: 14,
    color: 'var(--ink-3)',
    lineHeight: 1.6,
    marginBottom: 28,
  } as React.CSSProperties,

  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    marginBottom: 20,
  } as React.CSSProperties,

  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink-3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  } as React.CSSProperties,

  input: {
    fontFamily: 'var(--mono)',
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: '0.25em',
    textAlign: 'center' as const,
    padding: '12px 16px',
    border: '1px solid var(--rule-2)',
    borderRadius: 8,
    background: 'var(--bone)',
    color: 'var(--ink)',
    outline: 'none',
    width: '100%',
  } as React.CSSProperties,

  errorBox: {
    background: 'rgba(180,48,27,0.07)',
    border: '1px solid rgba(180,48,27,0.2)',
    borderRadius: 6,
    padding: '10px 14px',
    fontSize: 13,
    color: 'var(--red)',
  } as React.CSSProperties,

  button: {
    padding: '11px 20px',
    background: 'var(--ink)',
    color: 'var(--paper)',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  } as React.CSSProperties,

  hint: {
    fontSize: 12,
    color: 'var(--ink-5)',
    lineHeight: 1.6,
  } as React.CSSProperties,

  code: {
    fontFamily: 'var(--mono)',
    fontSize: '0.9em',
    background: 'var(--bone-2)',
    padding: '1px 5px',
    borderRadius: 3,
  } as React.CSSProperties,

  successIcon: {
    width: 48,
    height: 48,
    borderRadius: '50%',
    background: 'rgba(47,107,61,0.1)',
    color: 'var(--green)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 20,
  } as React.CSSProperties,
} as const;
