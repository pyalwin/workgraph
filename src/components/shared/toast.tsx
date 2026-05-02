'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { CheckCircle2, AlertTriangle, XCircle, X, Info } from 'lucide-react';

/**
 * Minimal toast system, no external deps. Replaces silent catches and
 * console.warn in client code with visible feedback. Server-side warnings
 * surface here when the response body includes a `warning` or `error` field.
 *
 * Usage:
 *   import { toast } from '@/components/shared/toast';
 *   toast.error('Failed to save key');
 *   toast.success('Saved');
 *   toast.info('Falling back to Gateway');
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

interface ToastEntry {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  durationMs: number;
  action?: { label: string; href?: string; onClick?: () => void };
}

interface ToastState {
  items: ToastEntry[];
  push: (entry: Omit<ToastEntry, 'id'>) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let _id = 0;

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (entry) => {
    const id = ++_id;
    set((s) => ({ items: [...s.items, { id, ...entry }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
  clear: () => set({ items: [] }),
}));

interface PushOpts {
  description?: string;
  durationMs?: number;
  action?: ToastEntry['action'];
}

const DEFAULT_DURATION_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

function push(tone: ToastTone, title: string, opts: PushOpts = {}) {
  return useToastStore.getState().push({
    tone,
    title,
    description: opts.description,
    durationMs: opts.durationMs ?? DEFAULT_DURATION_MS[tone],
    action: opts.action,
  });
}

export const toast = {
  info: (title: string, opts?: PushOpts) => push('info', title, opts),
  success: (title: string, opts?: PushOpts) => push('success', title, opts),
  warning: (title: string, opts?: PushOpts) => push('warning', title, opts),
  error: (title: string, opts?: PushOpts) => push('error', title, opts),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
  clear: () => useToastStore.getState().clear(),
};

const ICONS: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TONE_STYLES: Record<ToastTone, { bg: string; border: string; fg: string; iconColor: string }> = {
  info: { bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af', iconColor: '#2563eb' },
  success: { bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46', iconColor: '#059669' },
  warning: { bg: '#fffbeb', border: '#fde68a', fg: '#78350f', iconColor: '#d97706' },
  error: { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b', iconColor: '#dc2626' },
};

function ToastItem({ entry }: { entry: ToastEntry }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = ICONS[entry.tone];
  const style = TONE_STYLES[entry.tone];

  useEffect(() => {
    if (entry.durationMs <= 0) return;
    const t = window.setTimeout(() => dismiss(entry.id), entry.durationMs);
    return () => window.clearTimeout(t);
  }, [dismiss, entry.id, entry.durationMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'start',
        gap: '0.65rem',
        padding: '0.7rem 0.85rem',
        background: style.bg,
        color: style.fg,
        border: `1px solid ${style.border}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -2px rgba(15, 23, 42, 0.1)',
        minWidth: 280,
        maxWidth: 420,
        fontSize: '0.85rem',
      }}
    >
      <Icon size={16} style={{ color: style.iconColor, flexShrink: 0, marginTop: 1 }} aria-hidden />
      <div style={{ display: 'grid', gap: '0.2rem' }}>
        <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{entry.title}</div>
        {entry.description && (
          <div style={{ color: style.fg, opacity: 0.85, lineHeight: 1.4 }}>{entry.description}</div>
        )}
        {entry.action && (
          <div style={{ marginTop: '0.3rem' }}>
            {entry.action.href ? (
              <a
                href={entry.action.href}
                onClick={() => dismiss(entry.id)}
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: style.iconColor,
                  textDecoration: 'underline',
                }}
              >
                {entry.action.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={() => {
                  entry.action?.onClick?.();
                  dismiss(entry.id);
                }}
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: style.iconColor,
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {entry.action.label}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(entry.id)}
        aria-label="Dismiss notification"
        title="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: style.fg,
          opacity: 0.5,
          padding: 2,
          marginTop: -2,
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useToastStore((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        display: 'grid',
        gap: '0.5rem',
        pointerEvents: 'auto',
      }}
    >
      {items.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
