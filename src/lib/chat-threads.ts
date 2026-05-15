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

/**
 * Phase 3 — every chat thread query is workspace-scoped. Callers must pass
 * the active workspaceId resolved from the cookie via
 * getActiveWorkspaceId(); a fresh workspace sees zero threads until it
 * creates them.
 */
export async function listChatThreads(workspaceId: string): Promise<ChatThreadRow[]> {
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
       WHERE t.workspace_id = ?
       ORDER BY t.updated_at DESC
       LIMIT 200`,
    )
    .all<ChatThreadRow>(workspaceId);
}

export async function createChatThread(
  workspaceId: string,
  title?: string,
  explicitId?: string,
): Promise<ChatThreadRow> {
  await ensureInit();
  const db = getLibsqlDb();
  const id = explicitId ?? uuid();
  await db
    .prepare(`INSERT INTO chat_threads (id, title, workspace_id) VALUES (?, ?, ?)`)
    .run(id, title?.trim() || null, workspaceId);
  const row = await getChatThread(workspaceId, id);
  if (!row) throw new Error('createChatThread: row vanished after insert');
  return row;
}

export async function getChatThread(
  workspaceId: string,
  id: string,
): Promise<ChatThreadRow | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT id, title, created_at, updated_at FROM chat_threads WHERE id = ? AND workspace_id = ?`,
    )
    .get<ChatThreadRow>(id, workspaceId);
  return row ?? null;
}

export async function deleteChatThread(workspaceId: string, id: string): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  // chat_messages JOIN to chat_threads for workspace gate; deleting the
  // thread first would orphan the messages, so we delete messages whose
  // thread is in the right workspace.
  await db
    .prepare(
      `DELETE FROM chat_messages
       WHERE thread_id = ?
         AND thread_id IN (SELECT id FROM chat_threads WHERE id = ? AND workspace_id = ?)`,
    )
    .run(id, id, workspaceId);
  await db
    .prepare(`DELETE FROM chat_threads WHERE id = ? AND workspace_id = ?`)
    .run(id, workspaceId);
}

export async function renameChatThread(
  workspaceId: string,
  id: string,
  title: string,
): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db
    .prepare(
      `UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`,
    )
    .run(title.trim() || null, id, workspaceId);
}

export async function getChatMessages(
  workspaceId: string,
  threadId: string,
): Promise<UIMessage[]> {
  await ensureInit();
  const db = getLibsqlDb();
  // Filter via JOIN on chat_threads.workspace_id — chat_messages itself has
  // no workspace column.
  const rows = await db
    .prepare(
      `SELECT m.id, m.thread_id, m.role, m.parts, m.sequence, m.created_at
       FROM chat_messages m
       JOIN chat_threads t ON t.id = m.thread_id
       WHERE m.thread_id = ? AND t.workspace_id = ?
       ORDER BY m.sequence ASC`,
    )
    .all<ChatMessageRow>(threadId, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    role: r.role as UIMessage['role'],
    parts: JSON.parse(r.parts),
  })) as UIMessage[];
}

export async function replaceChatMessages(
  workspaceId: string,
  threadId: string,
  messages: UIMessage[],
): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  // Verify the thread belongs to the requested workspace before mutating.
  const owner = await db
    .prepare(`SELECT 1 AS hit FROM chat_threads WHERE id = ? AND workspace_id = ?`)
    .get<{ hit: number }>(threadId, workspaceId);
  if (!owner) throw new Error(`replaceChatMessages: thread ${threadId} not in workspace`);
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
    .prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(threadId, workspaceId);
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
