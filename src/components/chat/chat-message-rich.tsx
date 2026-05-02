'use client';

import { useState } from 'react';
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai';
import { Renderer } from '@openuidev/react-lang';
import { Markdown } from '@/components/chat/prompt-kit/markdown';
import { ToolPartView } from '@/components/chat/chat-tool-views';
import { curatedLibrary } from '@/lib/openui-curated';

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: `tool-${string}` }>;

export function ChatMessageRich({
  message,
  isStreaming = false,
}: {
  message: UIMessage;
  isStreaming?: boolean;
}) {
  const isUser = message.role === 'user';
  const hasVisibleContent = message.parts.some(
    (p) =>
      (p.type === 'text' && typeof (p as { text?: string }).text === 'string' && (p as { text: string }).text.trim().length > 0) ||
      (p.type.startsWith('tool-') && (p as { state?: string }).state === 'output-available'),
  );
  const showTyping = !isUser && isStreaming && !hasVisibleContent;

  return (
    <article className={`chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}`}>
      {!isUser && (
        <div className="chat-msg-avatar" aria-hidden>
          <span>✦</span>
        </div>
      )}
      <div className="chat-msg-content">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return isUser ? (
              <p key={i} className="chat-msg-user-text">{part.text}</p>
            ) : (
              <AssistantText key={i} text={part.text} isStreaming={isStreaming} />
            );
          }
          if (part.type.startsWith('tool-')) {
            return <ToolPartView key={i} part={part as ToolPart} />;
          }
          return null;
        })}
        {showTyping && (
          <div className="chat-msg-text chat-msg-typing-inline">
            <span className="chat-typing">
              <span /><span /><span />
            </span>
            <span className="chat-typing-label">Thinking…</span>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Walk the text line by line. Lines that look like OpenUI Lang
 * assignments (`name = Capitalized(...)`) are grouped together — including
 * blank lines that sit between assignments — into a `ui` segment that goes
 * to Renderer. Everything else stays as Markdown prose. This handles the
 * common case where the model emits an explanation, then a block of bare
 * OpenUI Lang (no fence), then a closing summary — all in one message.
 */
const FENCE_RE = /```openui-lang\b\s*\n([\s\S]*?)\n```/g;
const LANG_LINE = /^\s*[A-Za-z_]\w*\s*=\s*[A-Z]\w*\(/;

function splitByLine(text: string): Array<{ kind: 'md' | 'ui'; content: string }> {
  const lines = text.split('\n');
  const out: Array<{ kind: 'md' | 'ui'; content: string }> = [];
  let i = 0;
  while (i < lines.length) {
    if (LANG_LINE.test(lines[i])) {
      const start = i;
      // Greedily consume lang lines + blank lines that lead into another lang line.
      while (i < lines.length) {
        if (LANG_LINE.test(lines[i])) {
          i++;
          continue;
        }
        if (lines[i].trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && LANG_LINE.test(lines[j])) {
            i = j;
            continue;
          }
        }
        break;
      }
      out.push({ kind: 'ui', content: lines.slice(start, i).join('\n').trim() });
    } else {
      const start = i;
      while (i < lines.length && !LANG_LINE.test(lines[i])) i++;
      const md = lines.slice(start, i).join('\n');
      if (md.trim()) out.push({ kind: 'md', content: md });
    }
  }
  return out;
}

function splitOpenUiSegments(text: string): Array<{ kind: 'md' | 'ui'; content: string }> {
  // Fenced blocks first — they're always pure ui.
  let lastIdx = 0;
  const result: Array<{ kind: 'md' | 'ui'; content: string }> = [];
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) result.push(...splitByLine(text.slice(lastIdx, m.index)));
    result.push({ kind: 'ui', content: m[1] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) result.push(...splitByLine(text.slice(lastIdx)));
  return result;
}

function AssistantText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const segments = splitOpenUiSegments(text);
  const hasUi = segments.some((s) => s.kind === 'ui');

  if (!hasUi) {
    return (
      <div className="chat-msg-text">
        <Markdown compact>{text}</Markdown>
      </div>
    );
  }

  return (
    <div className="chat-msg-text openui-host">
      {segments.map((seg, i) =>
        seg.kind === 'md' ? (
          seg.content.trim() ? <Markdown key={i} compact>{seg.content}</Markdown> : null
        ) : (
          <RendererSegment key={i} content={seg.content} isStreaming={isStreaming} />
        ),
      )}
    </div>
  );
}

/**
 * Per-segment Renderer. Falls back to a code-formatted block (preserving
 * the OpenUI Lang source) on parse error — local to this segment so the
 * rest of the message keeps rendering normally.
 */
function RendererSegment({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <pre className="openui-fallback">
        <code>{content}</code>
      </pre>
    );
  }
  return (
    <Renderer
      response={content}
      library={curatedLibrary}
      isStreaming={isStreaming}
      onError={(err) => {
        // Renderer fires onError with an empty array when parse succeeded
        // but produced no statements yet (common during streaming or when
        // forward refs aren't resolved). Don't treat empty as failure.
        if (Array.isArray(err) && err.length === 0) return;
        console.warn('[openui] render error, falling back to code block:', err);
        setFailed(true);
      }}
    />
  );
}

export { ChatTyping } from '@/components/chat/chat-message';
