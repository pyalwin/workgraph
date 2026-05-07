'use client';

/**
 * AlmanacMarkdown
 *
 * Renders section markdown with Mermaid diagram support.
 * Mermaid blocks are rendered client-side after mount.
 * Malformed diagrams fall back to the source code with an error banner.
 *
 * Uses the existing react-markdown + remark-gfm setup but intercepts
 * ```mermaid code blocks for special rendering.
 */

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/* ------------------------------------------------------------------ */
/* Mermaid diagram block                                               */
/* ------------------------------------------------------------------ */

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!ref.current) return;

      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose',
        });

        // Generate a stable id from the code content
        const id = `mermaid-${Math.abs(
          code.split('').reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0),
        )}`;

        const { svg } = await mermaid.render(id, code.trim());

        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setRendered(true);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void render();
    return () => { cancelled = true; };
  }, [code]);

  return (
    <div style={mermaidStyles.wrap}>
      {error && (
        <div style={mermaidStyles.errorBanner}>
          Mermaid render error: {error}
        </div>
      )}
      {error ? (
        <pre style={mermaidStyles.fallbackCode}>{code}</pre>
      ) : (
        <div ref={ref} style={{ ...mermaidStyles.diagram, opacity: rendered ? 1 : 0 }} />
      )}
    </div>
  );
}

const mermaidStyles = {
  wrap: {
    margin: '16px 0',
    borderRadius: 8,
    border: '1px solid var(--rule)',
    overflow: 'hidden',
    background: 'var(--paper)',
  } as React.CSSProperties,

  errorBanner: {
    padding: '8px 14px',
    background: 'rgba(180,48,27,0.07)',
    color: 'var(--red)',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    borderBottom: '1px solid var(--rule)',
  } as React.CSSProperties,

  fallbackCode: {
    padding: 16,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    color: 'var(--ink-3)',
    whiteSpace: 'pre-wrap' as const,
    background: 'var(--bone)',
  } as React.CSSProperties,

  diagram: {
    padding: 16,
    display: 'flex',
    justifyContent: 'center',
    transition: 'opacity 0.2s',
    overflowX: 'auto' as const,
  } as React.CSSProperties,
} as const;

/* ------------------------------------------------------------------ */
/* Custom code component that intercepts mermaid blocks              */
/* ------------------------------------------------------------------ */

const mdComponents: Components = {
  // Intercept code blocks
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const language = match?.[1] ?? '';
    const isBlock = !props.node?.position ||
      props.node.position.start.line !== props.node.position.end.line;

    if (isBlock && language === 'mermaid') {
      return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
    }

    if (isBlock) {
      return (
        <pre style={{ overflow: 'auto', borderRadius: 6, padding: '12px 16px', background: 'var(--bone-2)', margin: '12px 0' }}>
          <code
            style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-2)' }}
            className={className}
          >
            {children}
          </code>
        </pre>
      );
    }

    return (
      <code
        style={{
          background: 'var(--bone-2)',
          color: 'var(--ink-2)',
          fontFamily: 'var(--mono)',
          fontSize: '0.88em',
          padding: '1px 5px',
          borderRadius: 3,
        }}
        className={className}
      >
        {children}
      </code>
    );
  },

  pre({ children }) {
    return <>{children}</>;
  },
};

/* ------------------------------------------------------------------ */
/* Public component                                                    */
/* ------------------------------------------------------------------ */

interface AlmanacMarkdownProps {
  children: string;
  className?: string;
}

export function AlmanacMarkdown({ children, className }: AlmanacMarkdownProps) {
  return (
    <div className={className} style={wrapStyle}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={mdComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  lineHeight: 1.7,
  color: 'var(--ink-2)',
  fontSize: 15,
};
