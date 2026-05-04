'use client';

import { useState } from 'react';

type State =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; agentId: string }
  | { kind: 'error'; message: string };

export function PairConfirmClient({ code }: { code: string }) {
  const [userCode, setUserCode] = useState(code);
  const [state, setState] = useState<State>({ kind: 'idle' });

  const codeMissing = !code;

  async function handleConfirm() {
    if (!userCode.trim()) {
      setState({ kind: 'error', message: 'Enter the code shown by the agent.' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/agent/pair/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_code: userCode.trim().toUpperCase() }),
      });
      const data = (await res.json()) as { ok?: boolean; agent_id?: string; error?: string };
      if (!res.ok || !data.ok || !data.agent_id) {
        setState({
          kind: 'error',
          message: data.error
            ? `Confirmation failed: ${data.error}`
            : `Confirmation failed (HTTP ${res.status}).`,
        });
        return;
      }
      setState({ kind: 'success', agentId: data.agent_id });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>Pair the Workgraph agent</h1>

        {state.kind === 'success' ? (
          <>
            <p style={proseStyle}>
              ✓ Agent paired. You can return to the terminal — the CLI should print
              <code style={codeInlineStyle}> Login successful</code> within a few seconds
              and write the token to <code style={codeInlineStyle}>~/.workgraph/agent.json</code>.
            </p>
            <p style={proseSubStyle}>
              <strong>Agent ID:</strong> <code style={codeInlineStyle}>{state.agentId}</code>
            </p>
          </>
        ) : (
          <>
            <p style={proseStyle}>
              Your local agent printed a short code in the terminal. Confirm here while
              signed in to grant the agent permission to act on your workspace.
            </p>

            <label style={labelStyle}>
              Code
              <input
                type="text"
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
                placeholder="ABCD1234"
                disabled={state.kind === 'submitting'}
                autoFocus={!codeMissing}
                style={inputStyle}
              />
            </label>

            {state.kind === 'error' && (
              <p style={errorStyle}>{state.message}</p>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={state.kind === 'submitting' || !userCode.trim()}
              style={buttonStyle(state.kind === 'submitting' || !userCode.trim())}
            >
              {state.kind === 'submitting' ? 'Confirming…' : 'Confirm and pair'}
            </button>

            <p style={hintStyle}>
              The code expires 10 minutes after the agent ran <code style={codeInlineStyle}>workgraph login</code>.
              If you missed it, re-run the command in your terminal.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: 'calc(100dvh - 64px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1rem',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 480,
  padding: '2rem',
  border: '1px solid var(--ink-2, #e5e5e5)',
  borderRadius: 12,
  background: 'var(--bg-1, #fff)',
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: '1rem',
  fontSize: 20,
  fontWeight: 600,
};

const proseStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: '1.5rem',
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink-4, #555)',
};

const proseSubStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--ink-4, #666)',
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink-5, #444)',
  marginBottom: '1rem',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 16,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  border: '1px solid var(--ink-2, #d4d4d4)',
  borderRadius: 6,
  outline: 'none',
};

const buttonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '10px 16px',
  fontSize: 14,
  fontWeight: 500,
  color: disabled ? '#aaa' : '#fff',
  background: disabled ? '#eee' : '#111',
  border: 'none',
  borderRadius: 6,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const errorStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: '1rem',
  fontSize: 13,
  color: '#b00020',
  background: '#fff0f1',
  padding: '8px 12px',
  borderRadius: 6,
};

const hintStyle: React.CSSProperties = {
  margin: 0,
  marginTop: '1rem',
  fontSize: 12,
  color: 'var(--ink-3, #888)',
};

const codeInlineStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.92em',
  background: 'var(--bg-2, #f5f5f5)',
  padding: '1px 6px',
  borderRadius: 4,
};
