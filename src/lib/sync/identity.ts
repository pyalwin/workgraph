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
import { getDb } from '../db';

export interface AuthIdentity {
  id: string;             // WorkOS user.id
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/** Returns the set of normalized aliases the auth user is known by in this workspace. */
export function getUserAliases(workspaceId: string, authUserId: string): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT alias FROM workspace_user_aliases WHERE workspace_id = ? AND auth_user_id = ?`,
    )
    .all(workspaceId, authUserId) as { alias: string }[];
  return new Set(rows.map((r) => normalizeAlias(r.alias)));
}

/**
 * Seed reasonable defaults for a new user-workspace pair from their auth
 * identity: full name, email, email handle (the part before @). Idempotent.
 */
export function seedAliasesFromAuth(
  workspaceId: string,
  identity: AuthIdentity,
  source = '*',
): void {
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

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO workspace_user_aliases (id, workspace_id, auth_user_id, source, alias)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const c of candidates) {
    insert.run(uuid(), workspaceId, identity.id, source, normalizeAlias(c));
  }
}

/** Recompute metadata.is_mine for every item in a source after a sync. */
export function recomputeIsMineForSource(
  workspaceId: string,
  authUserId: string,
  source: string,
): { updated: number } {
  const aliases = getUserAliases(workspaceId, authUserId);
  if (aliases.size === 0) return { updated: 0 };

  const db = getDb();
  const items = db
    .prepare(`SELECT id, author, metadata FROM work_items WHERE source = ?`)
    .all(source) as Array<{ id: string; author: string | null; metadata: string | null }>;

  const update = db.prepare(`UPDATE work_items SET metadata = ? WHERE id = ?`);
  let updated = 0;

  const tx = db.transaction(() => {
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
      const assignedToMe = item.author
        ? aliases.has(normalizeAlias(item.author))
        : false;

      if (meta.is_mine !== isMine || meta.assigned_to_me !== assignedToMe) {
        meta.is_mine = isMine;
        meta.assigned_to_me = assignedToMe;
        update.run(JSON.stringify(meta), item.id);
        updated++;
      }
    }
  });
  tx();

  return { updated };
}
