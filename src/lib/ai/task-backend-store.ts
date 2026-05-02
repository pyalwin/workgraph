import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import type { AITask } from '@/lib/ai';
import type { BackendId } from '@/lib/ai/cli-backends';

export const ALL_TASKS: AITask[] = [
  'enrich',
  'recap',
  'extract',
  'project-summary',
  'decision',
  'narrative',
  'chat',
];

export interface TaskBackendRow {
  task: AITask;
  backend_id: BackendId;
  updated_at: string;
}

const VALID: ReadonlySet<BackendId> = new Set(['sdk', 'claude', 'codex', 'gemini']);

function isValidBackend(v: unknown): v is BackendId {
  return typeof v === 'string' && VALID.has(v as BackendId);
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

// In-memory cache for sync access from getTaskBackend (used inside getModel,
// which is called sync in many places). Populated on first listTaskBackends
// call and refreshed after every setTaskBackend / clearTaskBackend.
let _cache: Map<string, BackendId> | null = null;

async function refreshCache(): Promise<Map<string, BackendId>> {
  await ensureInit();
  const db = getLibsqlDb();
  const rows = await db
    .prepare('SELECT task, backend_id FROM ai_task_backends')
    .all<{ task: string; backend_id: string }>();
  const map = new Map<string, BackendId>();
  for (const r of rows) {
    if (isValidBackend(r.backend_id)) map.set(r.task, r.backend_id);
  }
  _cache = map;
  return map;
}

/** Sync getter — reads from in-memory cache. Populated on first list call. */
export function getTaskBackend(task: AITask): BackendId | null {
  if (!_cache) {
    // Cold cache: trigger async load in the background. First call returns
    // null (sane default — getModel will fall back to the configured AI
    // SDK provider). Subsequent calls hit the cache.
    void refreshCache().catch((err) =>
      console.warn(`[task-backend-store] cache load failed: ${err.message}`),
    );
    return null;
  }
  return _cache.get(task) ?? null;
}

export async function listTaskBackends(): Promise<TaskBackendRow[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const rows = await db
    .prepare('SELECT task, backend_id, updated_at FROM ai_task_backends')
    .all<TaskBackendRow>();
  // Refresh the sync cache opportunistically.
  const map = new Map<string, BackendId>();
  for (const r of rows) {
    if (isValidBackend(r.backend_id)) map.set(r.task, r.backend_id);
  }
  _cache = map;
  return rows;
}

export async function setTaskBackend(task: AITask, backend: BackendId): Promise<void> {
  await ensureInit();
  if (!ALL_TASKS.includes(task)) throw new Error(`unknown task: ${task}`);
  if (!isValidBackend(backend)) throw new Error(`unknown backend: ${backend}`);
  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT INTO ai_task_backends (task, backend_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(task) DO UPDATE SET backend_id = excluded.backend_id, updated_at = datetime('now')`,
    )
    .run(task, backend);
  await refreshCache();
}

export async function clearTaskBackend(task: AITask): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db.prepare('DELETE FROM ai_task_backends WHERE task = ?').run(task);
  await refreshCache();
}
