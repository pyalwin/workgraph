'use client';

import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai';
import { Markdown } from '@/components/chat/prompt-kit/markdown';
import { ToolPartView } from '@/components/chat/chat-tool-views';

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: `tool-${string}` }>;

export function ChatMessage({
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
              <div key={i} className="chat-msg-text">
                <Markdown compact>{part.text}</Markdown>
              </div>
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

export function ChatTyping() {
  return (
    <article className="chat-msg chat-msg-assistant">
      <div className="chat-msg-avatar" aria-hidden>
        <span>✦</span>
      </div>
      <div className="chat-msg-content">
        <div className="chat-msg-text">
          <span className="chat-typing">
            <span /><span /><span />
          </span>
        </div>
      </div>
    </article>
  );
}
