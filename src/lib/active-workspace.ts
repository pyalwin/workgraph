import { cookies } from 'next/headers';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

const COOKIE = 'wg-workspace';
const FALLBACK = 'default';

/**
 * Resolves the workspace bound to the currently authenticated user.
 *
 * Behavior:
 *  - If the user owns a workspace (auth_user_id matches), returns its id.
 *  - If the user has none but unclaimed workspaces exist
 *    (auth_user_id IS NULL), claims the FIRST one (alphabetically by id)
 *    by stamping auth_user_id, and returns it. This handles the
 *    pre-Phase-4 deployments where workspaces were created without an
 *    owner — the first user to log in becomes the owner of the legacy
 *    workspace. Other unclaimed workspaces (e.g. seeded test data like
 *    `engineering-demo`, `founder`) remain unclaimed and INVISIBLE to
 *    the user; they can be cleaned up manually via direct DB access.
 *  - If neither, returns null — caller redirects to onboarding.
 *
 * Returns null when there is no authenticated user (e.g. called from a
 * background worker without a request context). Callers in those
 * situations must pass workspaceId explicitly.
 */
export async function getUserWorkspaceId(): Promise<string | null> {
  // Lazy import: withAuth pulls in the authkit-nextjs request hooks which
  // would crash when imported from worker contexts that never see this
  // helper anyway.
  let userId: string | null = null;
  try {
    const { withAuth } = await import('@workos-inc/authkit-nextjs');
    const { user } = await withAuth();
    userId = user?.id ?? null;
  } catch {
    return null;
  }
  if (!userId) return null;

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const owned = await db
    .prepare('SELECT id FROM workspace_config WHERE auth_user_id = ? ORDER BY id LIMIT 1')
    .get<{ id: string }>(userId);
  if (owned?.id) return owned.id;

  // No owned workspace: try to claim the alphabetically-first unclaimed
  // one. Skip the seeded `default` system row — it's a placeholder shared
  // across users and never should be auto-claimed.
  const unclaimed = await db
    .prepare(
      `SELECT id FROM workspace_config
       WHERE auth_user_id IS NULL AND id <> 'default'
       ORDER BY id LIMIT 1`,
    )
    .get<{ id: string }>();
  if (unclaimed?.id) {
    await db
      .prepare('UPDATE workspace_config SET auth_user_id = ? WHERE id = ? AND auth_user_id IS NULL')
      .run(userId, unclaimed.id);
    return unclaimed.id;
  }

  return null;
}

/**
 * Returns true if the authenticated user already owns a workspace. Used
 * by onboarding/UI to block creation of a second one.
 */
export async function userHasWorkspace(): Promise<boolean> {
  const id = await getUserWorkspaceId();
  return id !== null;
}

export async function getActiveWorkspaceId(): Promise<string> {
  // Phase 4: prefer user-bound workspace. Falls back to cookie / default
  // for legacy non-request callers (workers, cron jobs).
  try {
    const userWs = await getUserWorkspaceId();
    if (userWs) return userWs;
  } catch {
    // ignore — drop into cookie path below
  }
  try {
    const store = await cookies();
    const c = store.get(COOKIE);
    if (c?.value) return decodeURIComponent(c.value);
  } catch {
    // cookies() throws outside a request context (e.g. in Inngest workers).
    // Callers in those contexts should pass workspaceId explicitly.
  }
  return FALLBACK;
}

/**
 * Reads workspaceId from a query param first ("?workspace=") then the cookie.
 * Use in API routes that may also receive an explicit workspace.
 */
export async function getRequestWorkspaceId(searchParams: URLSearchParams): Promise<string> {
  const fromQuery = searchParams.get('workspace');
  if (fromQuery) return fromQuery;
  return getActiveWorkspaceId();
}

/**
 * Builds a SQL fragment that filters work_items to those whose source has
 * a connector configured in the given workspace. Used to scope user-facing
 * read paths to the active workspace under Option-2 (shared work_items
 * table; per-workspace visibility via JOIN).
 *
 * Usage:
 *   const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');
 *   db.prepare(`SELECT * FROM work_items wi WHERE ${filter.sql}`).all(...filter.params);
 *
 * tableAlias: prefix used for `source`. Pass '' for unqualified queries.
 *
 * If the workspace has no connector configs, returns a fragment that matches
 * nothing — so a freshly-created workspace shows zero items rather than
 * leaking cross-workspace data.
 */
export async function buildWorkspaceItemFilter(
  workspaceId: string,
  tableAlias = '',
): Promise<{ sql: string; params: string[] }> {
  await ensureSchemaAsync();
  const rows = await getLibsqlDb()
    .prepare('SELECT DISTINCT source FROM workspace_connector_configs WHERE workspace_id = ?')
    .all<{ source: string }>(workspaceId);
  const sources = rows.map((r) => r.source).filter(Boolean);
  const prefix = tableAlias ? `${tableAlias}.` : '';
  if (sources.length === 0) {
    return { sql: '0 = 1', params: [] };
  }
  const placeholders = sources.map(() => '?').join(', ');
  return {
    sql: `${prefix}source IN (${placeholders})`,
    params: sources,
  };
}
