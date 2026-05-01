'use client';

import { useEffect, useRef, useState } from 'react';
import { useWorkgraphState } from '@/components/workgraph-state';

export function Capture() {
  const { state } = useWorkgraphState();
  const [val, setVal] = useState('');
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        ref.current?.focus();
      }
      if (
        e.key === 'Enter' &&
        document.activeElement === ref.current &&
        val.trim()
      ) {
        setFlash(true);
        setVal('');
        setTimeout(() => setFlash(false), 900);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [val]);

  if (!state.showCapture) return null;

  return (
    <div className="capture" style={flash ? { borderColor: 'var(--green)' } : undefined}>
      <div className="capture-icon">+</div>
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={
          flash ? "Captured. I'll triage it into a pillar." : "Jot something — I'll triage it into a pillar"
        }
      />
      <div className="capture-hint">
        <kbd>⌘J</kbd>
      </div>
    </div>
  );
}
