import { v4 as uuid } from 'uuid';
import type { UIMessage } from 'ai';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export interface ChatThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_excerpt?: string | null;
}

interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: string;
  parts: string;
  sequence: number;
  created_at: string;
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function listChatThreads(): Promise<ChatThreadRow[]> {
  await ensureInit();
  const db = getLibsqlDb();
  return await db
    .prepare(
      `SELECT t.id, t.title, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT json_extract(m.parts, '$[0].text') FROM chat_messages m
                 WHERE m.thread_id = t.id AND m.role = 'user'
                 ORDER BY m.sequence ASC LIMIT 1) AS last_excerpt
       FROM chat_threads t
       ORDER BY t.updated_at DESC
       LIMIT 200`,
    )
    .all<ChatThreadRow>();
}

export async function createChatThread(title?: string, explicitId?: string): Promise<ChatThreadRow> {
  await ensureInit();
  const db = getLibsqlDb();
  const id = explicitId ?? uuid();
  await db.prepare(`INSERT INTO chat_threads (id, title) VALUES (?, ?)`).run(id, title?.trim() || null);
  const row = await getChatThread(id);
  if (!row) throw new Error('createChatThread: row vanished after insert');
  return row;
}

export async function getChatThread(id: string): Promise<ChatThreadRow | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare(`SELECT id, title, created_at, updated_at FROM chat_threads WHERE id = ?`)
    .get<ChatThreadRow>(id);
  return row ?? null;
}

export async function deleteChatThread(id: string): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).run(id);
  await db.prepare(`DELETE FROM chat_threads WHERE id = ?`).run(id);
}

export async function renameChatThread(id: string, title: string): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db
    .prepare(`UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(title.trim() || null, id);
}

export async function getChatMessages(threadId: string): Promise<UIMessage[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT id, thread_id, role, parts, sequence, created_at
       FROM chat_messages
       WHERE thread_id = ?
       ORDER BY sequence ASC`,
    )
    .all<ChatMessageRow>(threadId);
  return rows.map((r) => ({
    id: r.id,
    role: r.role as UIMessage['role'],
    parts: JSON.parse(r.parts),
  })) as UIMessage[];
}

export async function replaceChatMessages(threadId: string, messages: UIMessage[]): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).run(threadId);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    await db
      .prepare(
        `INSERT INTO chat_messages (id, thread_id, role, parts, sequence) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(m.id, threadId, m.role, JSON.stringify(m.parts ?? []), i);
  }
  await db
    .prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`)
    .run(threadId);
}

export function deriveThreadTitle(messages: UIMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return null;
  const text = first.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
}
