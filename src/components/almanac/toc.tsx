'use client';

import { useState } from 'react';
import type { SectionRow } from '@/app/(app)/projects/[key]/almanac/almanac-client';

interface Props {
  sections: SectionRow[];
  activeAnchor: string;
}

const TOP_KINDS = new Set(['cover', 'summary']);
const BOTTOM_KINDS = new Set(['drift_summary', 'drift_heatmap', 'decisions', 'appendix']);

interface Group {
  label: string;
  sections: SectionRow[];
  collapsible: boolean;
}

function groupSections(sections: SectionRow[]): Group[] {
  const top: SectionRow[] = [];
  const middle: SectionRow[] = [];
  const bottom: SectionRow[] = [];

  for (const s of sections) {
    if (TOP_KINDS.has(s.kind)) top.push(s);
    else if (BOTTOM_KINDS.has(s.kind)) bottom.push(s);
    else middle.push(s);
  }

  const groups: Group[] = [];
  if (top.length > 0) groups.push({ label: 'Overview', sections: top, collapsible: false });
  if (middle.length > 0) groups.push({ label: 'Units', sections: middle, collapsible: true });
  if (bottom.length > 0) groups.push({ label: 'Analysis', sections: bottom, collapsible: false });
  return groups;
}

export function AlmanacToc({ sections, activeAnchor }: Props) {
  const groups = groupSections(sections);
  const [unitsExpanded, setUnitsExpanded] = useState(true);

  return (
    <nav className="almanac-toc" aria-label="Almanac table of contents">
      {groups.map((group) => {
        const isUnits = group.collapsible;
        const expanded = isUnits ? unitsExpanded : true;

        return (
          <div key={group.label} className="almanac-toc-group">
            <div
              className="almanac-toc-group-label"
              onClick={isUnits ? () => setUnitsExpanded((v) => !v) : undefined}
              style={isUnits ? { cursor: 'pointer', userSelect: 'none' } : undefined}
            >
              {group.label}
              {isUnits && (
                <span className="almanac-toc-chevron">{expanded ? '▾' : '▸'}</span>
              )}
            </div>
            {expanded && (
              <ul className="almanac-toc-list">
                {group.sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.anchor}`}
                      className={`almanac-toc-link${activeAnchor === s.anchor ? ' active' : ''}`}
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
