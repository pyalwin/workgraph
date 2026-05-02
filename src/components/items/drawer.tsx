'use client';

import { useEffect, ReactNode } from 'react';

export interface DrawerRow {
  when: string;
  text: string;
  pillar?: string;
  source?: string;
}

export interface DrawerPayload {
  kind: 'list' | 'signal' | 'custom';
  title?: string;
  lede?: string;
  rows?: DrawerRow[];
  kicker?: string;
  content?: ReactNode;
}

export function Drawer({
  payload,
  onClose,
  wide = false,
}: {
  payload: DrawerPayload | null;
  onClose: () => void;
  wide?: boolean;
}) {
  const open = !!payload;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${wide ? 'wide' : ''} ${open ? 'open' : ''}`} role="dialog">
        {payload && (
          <>
            <div
              className="drawer-head"
              style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}
            >
              {payload.kicker && <span className="drawer-kicker">{payload.kicker}</span>}
            </div>
            <div className="drawer-body">
              {payload.content ? (
                payload.content
              ) : (
                <>
                  {payload.title && <h2>{payload.title}</h2>}
                  {payload.lede && <p className="lede">{payload.lede}</p>}
                  {payload.rows && payload.rows.length > 0 && (
                    <div className="drawer-rows">
                      {payload.rows.map((r, i) => (
                        <div className="drawer-row" key={i}>
                          <div className="when">{r.when}</div>
                          <div>
                            <div className="text">
                              {r.text}
                              {r.pillar && <span className="pillar-tag">{r.pillar}</span>}
                            </div>
                          </div>
                          <div className="src">{r.source}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <button
              className="drawer-close"
              style={{ position: 'absolute', top: 14, right: 14 }}
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </>
        )}
      </aside>
    </>
  );
}
