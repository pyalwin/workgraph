'use client';

import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string | React.ReactNode;
  warning?: string;          // amber-bg highlight, optional
  confirmLabel?: string;     // default 'Confirm'
  cancelLabel?: string;      // default 'Cancel'
  variant?: 'default' | 'danger';
  busy?: boolean;            // shows "<loading…>" on the confirm button
  busyLabel?: string;        // override the busy label
  onConfirm: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  warning,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  busy = false,
  busyLabel,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  const [internalBusy, setInternalBusy] = useState(false);
  const showingBusy = busy || internalBusy;

  const handleConfirm = async () => {
    setInternalBusy(true);
    try {
      await onConfirm();
    } finally {
      setInternalBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 bg-black/40 backdrop-blur-sm"
          style={{ zIndex: 200 }}
        />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%] w-[min(440px,92vw)] bg-white rounded-2xl border border-black/[0.08] shadow-2xl flex flex-col"
          style={{ zIndex: 201 }}
          onEscapeKeyDown={(e) => { if (showingBusy) e.preventDefault(); }}
          onPointerDownOutside={(e) => { if (showingBusy) e.preventDefault(); }}
        >
          <header className="px-6 pt-5 pb-4 flex items-start gap-3">
            {variant === 'danger' && (
              <div className="shrink-0 w-9 h-9 rounded-full grid place-items-center bg-red-50 text-red-600">
                <AlertTriangle className="w-4 h-4" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold text-black">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description asChild>
                  <div className="text-sm text-[#555] mt-1.5 leading-relaxed">
                    {description}
                  </div>
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              disabled={showingBusy}
              className="shrink-0 -mr-1 -mt-1 w-7 h-7 grid place-items-center rounded-full hover:bg-black/[0.05] text-[#666] disabled:opacity-40"
            >
              <X className="w-3.5 h-3.5" />
            </DialogPrimitive.Close>
          </header>

          {warning && (
            <div className="mx-6 mb-4 text-xs px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 leading-snug">
              ⚠ {warning}
            </div>
          )}

          <footer className="px-6 py-4 border-t border-black/[0.06] flex items-center justify-end gap-2 bg-[#fafafa] rounded-b-2xl">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onOpenChange(false)}
              disabled={showingBusy}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={showingBusy}
              className={[
                'btn',
                variant === 'danger'
                  ? 'btn-primary !bg-red-600 !text-white hover:!bg-red-700 disabled:!bg-red-300'
                  : 'btn-primary',
              ].join(' ')}
            >
              {showingBusy ? (busyLabel || `${confirmLabel}…`) : confirmLabel}
            </button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
