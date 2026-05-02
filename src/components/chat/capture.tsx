'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';
import { ChatMessage, ChatTyping } from '@/components/chat/chat-message';

const SUGGESTIONS = [
  'What projects are at risk this week?',
  'How many open PRs do we have?',
  'Recent decisions across the team',
  'Save a note: review the connector audit log',
];

export function Capture() {
  const { state } = useWorkgraphState();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [val, setVal] = useState('');
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      prepareSendMessagesRequest: ({ id, messages: msgs, body }) => {
        const overrideId = (body as { id?: string } | undefined)?.id;
        return { body: { id: overrideId ?? id, messages: msgs } };
      },
    }),
  });

  const isStreaming = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape' && open && document.activeElement === inputRef.current) {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isStreaming]);

  if (!state.showCapture) return null;
  if (pathname?.startsWith('/chat')) return null;

  const submit = (text?: string) => {
    const content = (text ?? val).trim();
    if (!content || isStreaming) return;
    setOpen(true);
    if (!threadIdRef.current) {
      const id = crypto.randomUUID();
      threadIdRef.current = id;
      setThreadId(id);
    }
    sendMessage({ text: content }, { body: { id: threadIdRef.current } });
    setVal('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const newChat = () => {
    setMessages([]);
    setThreadId(null);
    threadIdRef.current = null;
    setVal('');
    inputRef.current?.focus();
  };

  const expanded = open && (messages.length > 0 || val.trim().length > 0);

  return (
    <div ref={containerRef} className={`capture ${expanded ? 'is-expanded' : ''}`}>
      {expanded && (
        <div className="capture-panel">
          <div className="capture-panel-head">
            <span className="capture-panel-title">Workgraph chat</span>
            <div className="capture-panel-actions">
              {threadId && (
                <Link
                  href={`/chat?thread=${threadId}`}
                  className="capture-link-btn"
                  onClick={() => setOpen(false)}
                >
                  Open full chat
                </Link>
              )}
              {messages.length > 0 && (
                <button type="button" className="capture-link-btn" onClick={newChat}>
                  New
                </button>
              )}
              <button
                type="button"
                className="capture-link-btn"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="capture-messages">
            {messages.length === 0 && (
              <div className="capture-suggestions">
                <p className="capture-suggestions-head">Try asking</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className="capture-suggestion"
                    onClick={() => submit(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                message={m}
                isStreaming={isStreaming && i === messages.length - 1 && m.role === 'assistant'}
              />
            ))}
            {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && <ChatTyping />}
          </div>
        </div>
      )}

      <div className="capture-bar">
        <div className="capture-icon">{isStreaming ? '…' : '✦'}</div>
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={isStreaming ? 'Thinking…' : 'Ask anything · ⌘J'}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button type="button" className="capture-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <div className="capture-hint">
            <kbd>⌘J</kbd>
          </div>
        )}
      </div>
    </div>
  );
}
