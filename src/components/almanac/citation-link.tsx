'use client';

import { useState } from 'react';
import { ItemDetailDrawer } from '@/components/items/item-detail-drawer';

interface Props {
  reference: string;
  onClick?: () => void;
}

type RefKind = 'ticket' | 'pr' | 'commit';

function detectKind(ref: string): RefKind {
  if (/^[A-Z]+-\d+$/.test(ref)) return 'ticket';
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(ref)) return 'pr';
  return 'commit';
}

function buildPrUrl(ref: string): string {
  const [repoPath, num] = ref.split('#');
  return `https://github.com/${repoPath}/pull/${num}`;
}

export function CitationLink({ reference, onClick }: Props) {
  const kind = detectKind(reference);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    onClick?.();
    if (kind === 'ticket') {
      // Resolve source_id -> UUID
      try {
        const res = await fetch(`/api/items?source_id=${encodeURIComponent(reference)}`);
        if (res.ok) {
          const { id } = await res.json() as { id: string };
          setOpenItemId(id);
        }
      } catch {
        // ignore — drawer simply won't open
      }
    } else if (kind === 'pr') {
      window.open(buildPrUrl(reference), '_blank', 'noopener,noreferrer');
    } else {
      // commit sha — copy to clipboard
      void navigator.clipboard.writeText(reference).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  const tooltip =
    kind === 'ticket'
      ? 'Open ticket'
      : kind === 'pr'
        ? 'Open pull request'
        : copied
          ? 'Copied!'
          : 'Copy commit SHA';

  return (
    <>
      <button
        type="button"
        className="almanac-citation"
        title={tooltip}
        onClick={() => { void handleClick(); }}
        data-kind={kind}
      >
        {reference}
      </button>
      {kind === 'ticket' && (
        <ItemDetailDrawer
          itemId={openItemId}
          onClose={() => setOpenItemId(null)}
        />
      )}
    </>
  );
}
