'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ChatMessageRich, ChatTyping } from '@/components/chat/chat-message-rich';

interface ThreadSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_excerpt?: string | null;
}

const SUGGESTIONS = [
  'What projects are at risk this week?',
  'How many open PRs do we have?',
  'Recent decisions across the team',
  'Show me items where status is in_progress',
];

export function ChatPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const threadIdFromUrl = searchParams.get('thread');

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(threadIdFromUrl);
  const [val, setVal] = useState('');
  const [backend, setBackend] = useState<string>('sdk');
  const [backends, setBackends] = useState<Array<{ id: string; label: string; available: boolean }>>([
    { id: 'sdk', label: 'Vercel AI SDK', available: true },
  ]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadIdRef = useRef<string | null>(threadIdFromUrl);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      prepareSendMessagesRequest: ({ id, messages: msgs, body }) => {
        const b = (body ?? {}) as { id?: string; backend?: string };
        return { body: { id: b.id ?? id, messages: msgs, backend: b.backend ?? 'sdk' } };
      },
    }),
  });

  const isStreaming = status === 'submitted' || status === 'streaming';

  const refreshThreads = useCallback(async () => {
    const res = await fetch('/api/chat/threads');
    if (!res.ok) return;
    const json = (await res.json()) as { threads: ThreadSummary[] };
    setThreads(json.threads);
  }, []);

  useEffect(() => {
    refreshThreads();
    fetch('/api/chat/backends')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.backends) setBackends(j.backends);
      });
  }, [refreshThreads]);

  // Reload thread messages when active thread changes
  useEffect(() => {
    if (!activeThreadId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/chat/threads/${activeThreadId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        setMessages(json.messages as UIMessage[]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, setMessages]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [val]);

  // Refresh thread list after a turn finishes (title may have been derived)
  useEffect(() => {
    if (status === 'ready' && messages.length > 0) {
      refreshThreads();
    }
  }, [status, messages.length, refreshThreads]);

  const newChat = useCallback(() => {
    setActiveThreadId(null);
    threadIdRef.current = null;
    setMessages([]);
    setVal('');
    router.replace('/chat');
    inputRef.current?.focus();
  }, [router, setMessages]);

  const openThread = useCallback(
    (id: string) => {
      setActiveThreadId(id);
      threadIdRef.current = id;
      router.replace(`/chat?thread=${id}`);
    },
    [router],
  );

  const submit = useCallback(
    (text?: string) => {
      const content = (text ?? val).trim();
      if (!content || isStreaming) return;
      let id = threadIdRef.current;
      if (!id) {
        id = crypto.randomUUID();
        threadIdRef.current = id;
        setActiveThreadId(id);
        router.replace(`/chat?thread=${id}`);
      }
      sendMessage({ text: content }, { body: { id, backend } });
      setVal('');
    },
    [val, isStreaming, sendMessage, router, backend],
  );

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const deleteThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' });
    if (activeThreadId === id) newChat();
    refreshThreads();
  };

  return (
    <div className="chat-page">
      <aside className="chat-sidebar">
        <button type="button" className="chat-new-btn" onClick={newChat}>
          + New chat
        </button>
        <div className="chat-thread-list">
          {threads.length === 0 ? (
            <p className="chat-empty">No chats yet.</p>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`chat-thread-row ${activeThreadId === t.id ? 'is-active' : ''}`}
                onClick={() => openThread(t.id)}
              >
                <span className="chat-thread-title">
                  {t.title || t.last_excerpt || 'Untitled'}
                </span>
                <span className="chat-thread-meta">
                  {formatRelative(t.updated_at)}
                  {t.message_count ? ` · ${t.message_count}` : ''}
                </span>
                <span
                  className="chat-thread-del"
                  onClick={(e) => deleteThread(t.id, e)}
                  role="button"
                  tabIndex={0}
                  aria-label="Delete chat"
                >
                  ×
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="chat-main">
        <div ref={scrollRef} className="chat-stream">
          {messages.length === 0 ? (
            <div className="chat-empty-state">
              <h1 className="chat-empty-title">Workgraph chat</h1>
              <p className="chat-empty-sub">
                Ask anything about your projects, tickets, decisions, or recent activity.
              </p>
              <div className="chat-empty-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className="chat-empty-suggestion"
                    onClick={() => submit(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-stream-inner">
              {messages.map((m, i) => (
                <ChatMessageRich
                  key={m.id}
                  message={m}
                  isStreaming={isStreaming && i === messages.length - 1 && m.role === 'assistant'}
                />
              ))}
              {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && <ChatTyping />}
            </div>
          )}
        </div>

        <div className="chat-composer">
          <div className="chat-composer-card">
            <textarea
              ref={inputRef}
              className="chat-composer-input"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={onKey}
              placeholder={isStreaming ? 'Thinking…' : 'Ask anything · Shift+Enter for newline'}
              disabled={isStreaming}
              rows={1}
            />
            <div className="chat-composer-actions">
              <select
                className="chat-backend-select"
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
                disabled={isStreaming}
                title="Backend"
              >
                {backends.map((b) => (
                  <option key={b.id} value={b.id} disabled={!b.available}>
                    {b.label}
                    {!b.available ? ' (not installed)' : ''}
                  </option>
                ))}
              </select>
              {isStreaming ? (
                <button type="button" className="chat-composer-btn" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-composer-btn primary"
                  onClick={() => submit()}
                  disabled={!val.trim()}
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
