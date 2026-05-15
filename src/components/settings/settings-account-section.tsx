'use client';

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

/**
 * Account deletion section. Renders a destructive "Delete account" button
 * inside the Profile / settings advanced area, gated behind a "type DELETE"
 * confirmation modal.
 *
 * On success it sends the user to /auth/signout so the WorkOS cookie is
 * cleared — the user record itself has already been removed by the API
 * route, but the cookie alone would otherwise let them poke at /api routes
 * for a few more seconds before authkit catches up.
 */
export function SettingsAccountSection() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setConfirmText('');
    setError(null);
    setBusy(false);
  };

  const handleClose = (next: boolean) => {
    if (busy) return; // don't let users dismiss mid-call
    setOpen(next);
    if (!next) reset();
  };

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        setBusy(false);
        return;
      }
      // Hard redirect — full page navigation clears any in-memory state.
      // The auth cookie was cleared by the API response, so going to "/"
      // directly is correct: bouncing through /auth/signout would hit
      // WorkOS' logout with a now-invalid session_id and serve a blank
      // page (the WorkOS user has already been deleted).
      window.location.href = data.signOutUrl || '/';
    } catch (err: any) {
      setError(err?.message || 'Unexpected error');
      setBusy(false);
    }
  };

  const canConfirm = confirmText.trim() === 'DELETE' && !busy;

  return (
    <div className="mt-11 pt-8 border-t border-black/[0.08]">
      <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#c53030] mb-4">
        Danger zone
      </h2>
      <div className="rounded-xl border border-red-200/70 bg-red-50/40 px-5 py-4 flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 max-w-[640px]">
          <div className="text-[0.92rem] font-semibold text-black tracking-tight">
            Delete account
          </div>
          <div className="text-[0.78rem] text-[#666] mt-1 leading-relaxed">
            Permanently removes your workspace and every item synced into it,
            revokes the OAuth tokens for connected apps where the provider
            allows it, and closes your account at our identity provider
            (WorkOS). After this completes you'll be signed out and any
            attempt to sign back in with the same email will create a fresh
            account. This action cannot be undone.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-lg bg-red-600 text-white px-4 py-[7px] text-[0.82rem] font-medium border-none cursor-pointer hover:bg-red-700 transition-colors"
        >
          Delete account
        </button>
      </div>

      <DialogPrimitive.Root open={open} onOpenChange={handleClose}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            style={{ zIndex: 200 }}
          />
          <DialogPrimitive.Content
            className="fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%] w-[min(480px,92vw)] bg-white rounded-2xl border border-black/[0.08] shadow-2xl flex flex-col"
            style={{ zIndex: 201 }}
            onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}
            onPointerDownOutside={(e) => { if (busy) e.preventDefault(); }}
          >
            <header className="px-6 pt-5 pb-4 flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-full grid place-items-center bg-red-50 text-red-600">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <DialogPrimitive.Title className="text-base font-semibold text-black">
                  Delete your account?
                </DialogPrimitive.Title>
                <DialogPrimitive.Description asChild>
                  <div className="text-sm text-[#555] mt-1.5 leading-relaxed">
                    This will permanently:
                    <ul className="list-disc pl-5 mt-2 space-y-0.5 text-[0.85rem]">
                      <li>Delete your workspace and all items synced into it</li>
                      <li>Remove every connector configuration and OAuth token</li>
                      <li>Revoke access at each connected provider where supported</li>
                      <li>Close your account at our identity provider (WorkOS)</li>
                    </ul>
                  </div>
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                disabled={busy}
                className="shrink-0 -mr-1 -mt-1 w-7 h-7 grid place-items-center rounded-full hover:bg-black/[0.05] text-[#666] disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" />
              </DialogPrimitive.Close>
            </header>

            <div className="px-6 pb-4">
              <label className="block text-[0.78rem] text-[#444] mb-1.5">
                Type <span className="font-mono font-semibold text-black">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={busy}
                autoFocus
                placeholder="DELETE"
                className="w-full px-3 py-[7px] rounded-lg border border-black/[0.1] text-[0.85rem] text-[#222] placeholder:text-[#bbb] outline-none focus:border-red-400 transition-colors bg-white font-mono"
              />
              {error && (
                <div className="mt-3 text-[0.78rem] px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700">
                  {error}
                </div>
              )}
            </div>

            <footer className="px-6 py-4 border-t border-black/[0.06] flex items-center justify-end gap-2 bg-[#fafafa] rounded-b-2xl">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => handleClose(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={!canConfirm}
                className="btn btn-primary !bg-red-600 !text-white hover:!bg-red-700 disabled:!bg-red-300"
              >
                {busy ? 'Deleting…' : 'Delete account'}
              </button>
            </footer>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
