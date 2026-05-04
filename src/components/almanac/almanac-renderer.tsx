'use client';

import { useMemo, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CitationLink } from './citation-link';
import { renderDiagram } from './diagrams/registry';

interface Props {
  markdown: string;
  diagramBlocks: unknown[];
  onCitationClick?: (ref: string) => void;
}

interface DiagramToken {
  kind: 'diagram';
  type: string;
  params: unknown;
  placeholder: string;
}

// Regex to match :::diagram type=<kind> params=<json>:::
// Uses a permissive JSON capture that handles nested braces up to 3 levels.
const DIAGRAM_FENCE =
  /^:::diagram\s+type=(\w+)\s+params=(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})\s*:::$/gm;

function parseDiagramFences(markdown: string): {
  processed: string;
  tokens: Map<string, DiagramToken>;
} {
  const tokens = new Map<string, DiagramToken>();
  let idx = 0;
  const processed = markdown.replace(DIAGRAM_FENCE, (_match, type: string, paramsStr: string) => {
    const placeholder = `__DIAGRAM_${idx++}__`;
    let params: unknown = {};
    try {
      params = JSON.parse(paramsStr) as unknown;
    } catch {
      params = { raw: paramsStr };
    }
    tokens.set(placeholder, { kind: 'diagram', type, params, placeholder });
    return placeholder;
  });
  return { processed, tokens };
}

// Citation regex: matches [KAN-123], [org/repo#45], [abc1234567] at word boundaries
// but does NOT match standard markdown links [text](url)
const CITATION_RE = /\[([A-Z]+-\d+|[\w.-]+\/[\w.-]+#\d+|[0-9a-f]{7,12})\](?!\()/g;

function renderTextWithCitations(
  text: string,
  onCitationClick?: (ref: string) => void,
): ReactElement[] {
  const parts: ReactElement[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  CITATION_RE.lastIndex = 0;

  while ((match = CITATION_RE.exec(text)) !== null) {
    const before = text.slice(last, match.index);
    if (before) parts.push(<span key={`t-${last}`}>{before}</span>);
    const ref = match[1];
    parts.push(
      <CitationLink
        key={`c-${match.index}`}
        reference={ref}
        onClick={onCitationClick ? () => onCitationClick(ref) : undefined}
      />,
    );
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (tail) parts.push(<span key={`t-${last}`}>{tail}</span>);
  return parts;
}

export function AlmanacRenderer({ markdown, diagramBlocks: _diagramBlocks, onCitationClick }: Props) {
  const { processed, tokens } = useMemo(() => parseDiagramFences(markdown), [markdown]);

  const components: Partial<Components> = useMemo(
    () => ({
      // Render diagram placeholders when they appear as standalone paragraphs
      p({ children }) {
        const text = typeof children === 'string' ? children : null;
        if (text && tokens.has(text.trim())) {
          const token = tokens.get(text.trim())!;
          const diagram = renderDiagram(token.type, token.params);
          if (diagram) return <div className="almanac-diagram">{diagram}</div>;
          return (
            <div className="almanac-diagram-fallback">
              <pre>{JSON.stringify(token.params, null, 2)}</pre>
            </div>
          );
        }
        // Render paragraph text with citation detection
        if (typeof children === 'string') {
          const parts = renderTextWithCitations(children, onCitationClick);
          return <p>{parts}</p>;
        }
        return <p>{children}</p>;
      },
      // Handle citation detection inside text nodes within other elements
      text({ children }) {
        if (typeof children !== 'string') return <>{children}</>;
        if (!CITATION_RE.test(children)) {
          CITATION_RE.lastIndex = 0;
          return <>{children}</>;
        }
        CITATION_RE.lastIndex = 0;
        const parts = renderTextWithCitations(children, onCitationClick);
        return <>{parts}</>;
      },
    }),
    [tokens, onCitationClick],
  );

  return (
    <div className="almanac-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}
