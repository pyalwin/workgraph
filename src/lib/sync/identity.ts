/**
 * Identity resolution — Phase 2.4.
 *
 * Auth gives us a WorkOS user (id + email + first/last name).
 * Sources give us display names, emails, account IDs, handles.
 * `workspace_user_aliases` is the user-edited lookup table that connects them.
 *
 * `is_mine` on a work_item is computed by checking whether any alias for
 * the auth user appears in the item's metadata.assignees_raw /
 * reporters_raw fields, OR matches the item's `author`.
 */
import { v4 as uuid } from 'uuid';
import { getLibsqlDb } from '../db/libsql';

export interface AuthIdentity {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

export async function getUserAliases(workspaceId: string, authUserId: string): Promise<Set<string>> {
  const db = getLibsqlDb();
  const rows = await db
    .prepare(`SELECT alias FROM workspace_user_aliases WHERE workspace_id = ? AND auth_user_id = ?`)
    .all<{ alias: string }>(workspaceId, authUserId);
  return new Set(rows.map((r) => normalizeAlias(r.alias)));
}

export async function seedAliasesFromAuth(
  workspaceId: string,
  identity: AuthIdentity,
  source = '*',
): Promise<void> {
  if (!identity.id) return;
  const candidates = new Set<string>();
  const fullName = [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim();
  if (fullName) candidates.add(fullName);
  if (identity.firstName) candidates.add(identity.firstName);
  if (identity.email) {
    candidates.add(identity.email);
    const handle = identity.email.split('@')[0];
    if (handle) candidates.add(handle);
  }

  const db = getLibsqlDb();
  for (const c of candidates) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO workspace_user_aliases (id, workspace_id, auth_user_id, source, alias)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(uuid(), workspaceId, identity.id, source, normalizeAlias(c));
  }
}

export async function recomputeIsMineForSource(
  workspaceId: string,
  authUserId: string,
  source: string,
): Promise<{ updated: number }> {
  const aliases = await getUserAliases(workspaceId, authUserId);
  if (aliases.size === 0) return { updated: 0 };

  const db = getLibsqlDb();
  const items = await db
    .prepare(`SELECT id, author, metadata FROM work_items WHERE source = ?`)
    .all<{ id: string; author: string | null; metadata: string | null }>(source);

  let updated = 0;

  for (const item of items) {
    let meta: any;
    try {
      meta = item.metadata ? JSON.parse(item.metadata) : {};
    } catch {
      meta = {};
    }

    const haystack: string[] = [];
    if (item.author) haystack.push(item.author);
    if (Array.isArray(meta.assignees_raw)) haystack.push(...meta.assignees_raw.filter(Boolean));
    if (Array.isArray(meta.reporters_raw)) haystack.push(...meta.reporters_raw.filter(Boolean));

    const normalized = haystack.map(normalizeAlias);
    const isMine = normalized.some((h) => aliases.has(h));
    const assignedToMe = item.author ? aliases.has(normalizeAlias(item.author)) : false;

    if (meta.is_mine !== isMine || meta.assigned_to_me !== assignedToMe) {
      meta.is_mine = isMine;
      meta.assigned_to_me = assignedToMe;
      await db.prepare(`UPDATE work_items SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), item.id);
      updated++;
    }
  }

  return { updated };
}
