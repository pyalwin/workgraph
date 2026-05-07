'use client';

/**
 * AlmanacInteractive
 *
 * OpenUI-powered renderer for almanac sections. Differences from the
 * plain markdown renderer:
 * - Wraps content in an OpenUI Card with the section title as a CardHeader.
 * - Adds a subsection chip nav at the top (when there are 2+ subsections),
 *   which smooth-scrolls to the corresponding `<h3>` in the rendered prose.
 * - Uses OpenUI's MarkDownRenderer for prose: themed typography,
 *   syntax-highlighted CodeBlock for non-mermaid code, native GFM support
 *   for footnotes (passed via remark-gfm).
 * - Mermaid blocks are intercepted and rendered with our existing
 *   MermaidBlock so diagrams keep working.
 */

import { useMemo, useState } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card, CodeBlock, MarkDownRenderer } from '@openuidev/react-ui';
import { MermaidBlock } from '@/components/almanac/almanac-markdown';
import { parseSection, slugify } from '@/lib/almanac/parse-section';

const REFERENCE_DEF_RE = /^\[\^[^\]]+\]:/gm;

interface AlmanacInteractiveProps {
  /** Full section markdown, starting with `## <title>`. */
  markdown: string;
  /** Section heading shown in the card. */
  title: string;
  /** Used to namespace generated heading ids so multiple sections can coexist. */
  sectionSlug: string;
  /** Action slot to the right of the header (e.g. Regenerate button). */
  headerAction?: React.ReactNode;
}

export function AlmanacInteractive({
  markdown,
  title,
  sectionSlug,
  headerAction,
}: AlmanacInteractiveProps) {
  const parsed = useMemo(() => parseSection(markdown), [markdown]);
  const [showRefs, setShowRefs] = useState(false);

  // Count footnote definitions in the source markdown so the toggle
  // can show "Show references (12)".
  const refCount = useMemo(() => {
    return (markdown.match(REFERENCE_DEF_RE) ?? []).length;
  }, [markdown]);

  // The agent ends each section with a `### References` heading followed
  // by the GFM footnote definitions. remark-gfm hoists the definitions
  // out into a `<section data-footnotes>` block at the end, leaving the
  // heading as a useless artefact. Strip it before rendering.
  const bodyWithoutRefsHeading = useMemo(
    () => parsed.body.replace(/^###\s+References\s*$/gim, ''),
    [parsed.body],
  );

  const handleChipClick = (slug: string) => {
    const id = `${sectionSlug}--${slug}`;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const options = useMemo(
    () => ({
      remarkPlugins: [remarkGfm],
      components: {
        code: CodeOrMermaid,
        h3: ({ children, ...rest }) => {
          const text = childrenToString(children);
          const id = `${sectionSlug}--${slugify(text)}`;
          return (
            <h3 id={id} {...rest}>
              {children}
            </h3>
          );
        },
        // Hoist the auto-generated footnotes block: when remark-gfm wraps
        // the references in a `<section data-footnotes>`, render it
        // collapsed by default and expanded only when the user opts in.
        section: ({ children, ...rest }) => {
          const isFootnotes = (rest as Record<string, unknown>)['data-footnotes'] !== undefined;
          if (!isFootnotes) {
            return <section {...rest}>{children}</section>;
          }
          return (
            <section
              {...rest}
              style={{
                ...((rest as { style?: React.CSSProperties }).style ?? {}),
                display: showRefs ? 'block' : 'none',
              }}
            >
              {children}
            </section>
          );
        },
      } satisfies Components,
    }),
    [sectionSlug, showRefs],
  );

  return (
    <Card variant="clear" style={cardStyle}>
      <div style={headerRowStyle}>
        <h2 className="almanac-section-title">{title}</h2>
        {headerAction ? <div style={{ flexShrink: 0 }}>{headerAction}</div> : null}
      </div>

      {parsed.subsections.length > 1 && (
        <div className="almanac-chip-nav" role="navigation" aria-label="Subsections">
          {parsed.subsections.map((s) => (
            <button
              key={s.slug}
              type="button"
              onClick={() => handleChipClick(s.slug)}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

      <MarkDownRenderer
        textMarkdown={bodyWithoutRefsHeading}
        variant="clear"
        options={options}
      />

      {refCount > 0 && (
        <button
          type="button"
          onClick={() => setShowRefs((v) => !v)}
          aria-expanded={showRefs}
          style={refsToggleStyle}
        >
          <span style={refsToggleArrow(showRefs)}>›</span>
          {showRefs ? 'Hide' : 'Show'} references ({refCount})
        </button>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

const CodeOrMermaid: Components['code'] = ({ className, children, ...rest }) => {
  const match = /language-(\w+)/.exec(className ?? '');
  const text = String(children).replace(/\n$/, '');
  // Heuristic identical to the OpenUI MarkDownRenderer's internal logic:
  // a fenced block has either a language match or contains newlines.
  const isBlock = Boolean(match) || (!className && text.includes('\n'));
  if (isBlock) {
    if (match?.[1] === 'mermaid') {
      return <MermaidBlock code={text} />;
    }
    return <CodeBlock language={match?.[1] ?? 'text'} codeString={text} />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
};

function childrenToString(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToString).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenToString((children as { props: { children: React.ReactNode } }).props.children);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const cardStyle: React.CSSProperties = {
  padding: 0,
  marginBottom: 56,
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 8,
};

const refsToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 16,
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--ink-3)',
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
};

const refsToggleArrow = (open: boolean): React.CSSProperties => ({
  display: 'inline-block',
  transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
  transition: 'transform 0.15s',
  fontSize: 14,
  lineHeight: 1,
});
