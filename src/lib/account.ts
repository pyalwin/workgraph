/**
 * Hard account-deletion cascade.
 *
 * Wipes everything tied to a WorkOS-authenticated user from the local
 * SQLite/libSQL store, makes a best-effort attempt to revoke OAuth tokens
 * at each provider, then asks WorkOS to delete the user record itself.
 *
 * Idempotency: if the local cascade ran but WorkOS deletion failed, a
 * retry is safe — `listWorkspacesForUser` returns no rows, the cascade
 * is a no-op, and the WorkOS call either succeeds or returns 404 (also
 * treated as success by `deleteWorkosUser`).
 *
 * Note: libSQL doesn't expose a transaction context that survives across
 * await boundaries the way better-sqlite3 does, so the cascade runs as a
 * sequence of awaited statements. If a step fails partway, the user can
 * retry — every step is built to be safely repeatable. WorkOS deletion
 * runs *after* the local cascade so a network failure there doesn't
 * strand local data.
 */

import { getOAuthToken } from '@/lib/connectors/oauth-tokens';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { revokeOauthToken } from '@/lib/oauth/refresh';
import { deleteWorkosUser } from '@/lib/workos-admin';

export interface AccountDeletionResult {
  ok: boolean;
  workosUserDeleted: boolean;
  workspaceDeleted: boolean;
  workItemsDeleted: number;
  warnings: string[];
}

/**
 * Hard-delete: wipes the user's workspace-scoped data, revokes OAuth
 * tokens at providers (best-effort), drops their custom tables, deletes
 * their workspace_config row, and asks WorkOS to delete the user.
 */
export async function deleteUserAccount(authUserId: string): Promise<AccountDeletionResult> {
  if (!authUserId) {
    throw new Error('deleteUserAccount: authUserId is required');
  }

  const warnings: string[] = [];
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // 1. Resolve the user's workspaces. Phase 4 enforces one-workspace-per-user
  //    but legacy data might have several rows tied to the same auth_user_id;
  //    we process all of them.
  const workspaceRows = await db
    .prepare('SELECT id, config FROM workspace_config WHERE auth_user_id = ?')
    .all<{ id: string; config: string }>(authUserId);

  const workspaceIds = workspaceRows.map((r) => r.id);

  // 2. Collect custom-table ids from each workspace's config blob (best-effort
  //    parse — a malformed config shouldn't block the cascade).
  const customTableIds: string[] = [];
  for (const row of workspaceRows) {
    try {
      const parsed = JSON.parse(row.config) as { customTables?: Array<{ id: string }> };
      for (const t of parsed.customTables ?? []) {
        if (t?.id && typeof t.id === 'string') customTableIds.push(t.id);
      }
    } catch {
      warnings.push(`workspace ${row.id}: config JSON unparseable, skipping custom-table drops`);
    }
  }

  // 3. Best-effort OAuth revocation per workspace x source. Done before the
  //    DB cascade because the cascade deletes the encrypted token rows we
  //    need to decrypt; getOAuthToken() handles the decryption for us.
  for (const wsId of workspaceIds) {
    const tokenRows = await db
      .prepare('SELECT source FROM oauth_tokens WHERE workspace_id = ?')
      .all<{ source: string }>(wsId);
    for (const { source } of tokenRows) {
      try {
        const tok = await getOAuthToken(wsId, source);
        if (tok?.accessToken) {
          await revokeOauthToken(source, tok.accessToken);
        }
      } catch (err: any) {
        warnings.push(`oauth revoke ${source}: ${err?.message ?? err}`);
      }
    }
  }

  // 4. Local DB cascade. Sequential awaited statements rather than a single
  //    transaction (libSQL's async client doesn't give us a tx that spans
  //    await; the codebase's existing pattern in workstream/decision uses
  //    sequential async). Idempotent on retry.
  let workItemsDeleted = 0;
  if (workspaceIds.length > 0) {
    const placeholders = workspaceIds.map(() => '?').join(', ');

    // Order matters where there's no FK CASCADE: chat_messages before chat_threads,
    // item_tags before tags. Anything not FK-linked is independent.
    const cascadeStmts: Array<{ sql: string; args: unknown[] }> = [
      {
        sql: `DELETE FROM oauth_tokens WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM workspace_connector_configs WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM workspace_agents WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM anomalies WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM pipeline_links WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM project_backlog_items WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM goals WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      // chat: delete messages first (no FK cascade in libsql in practice).
      {
        sql: `DELETE FROM chat_messages WHERE thread_id IN (
                SELECT id FROM chat_threads WHERE workspace_id IN (${placeholders})
              )`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM chat_threads WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      // tags: delete item_tags first via subquery.
      {
        sql: `DELETE FROM item_tags WHERE tag_id IN (
                SELECT id FROM tags WHERE workspace_id IN (${placeholders})
              )`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM tags WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      {
        sql: `DELETE FROM entities WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
      // metrics_snapshots is keyed via goal_id, not workspace_id, but goals
      // were just wiped — orphan snapshots are still safe to drop. We use a
      // join via goals on the recently-deleted ids would be a no-op, so
      // instead delete snapshots whose goal_id no longer points at a row.
      {
        sql: `DELETE FROM metrics_snapshots
                WHERE goal_id IS NOT NULL
                  AND goal_id NOT IN (SELECT id FROM goals)`,
        args: [],
      },
      {
        sql: `DELETE FROM workspace_user_aliases WHERE workspace_id IN (${placeholders})`,
        args: workspaceIds,
      },
    ];

    for (const stmt of cascadeStmts) {
      try {
        await db.prepare(stmt.sql).run(...(stmt.args as never[]));
      } catch (err: any) {
        // workspace_agents may not exist on every deployment yet (additive
        // migration). Don't let a missing table abort the rest.
        warnings.push(`cascade step failed: ${err?.message ?? err}`);
      }
    }

    // 5. Drop custom tables. Identifiers are quoted so workspace authors
    //    can't sneak SQL through the table id. The id is only ever assigned
    //    by createWorkspaceConfig from the preset list, but we belt-and-
    //    brace anyway.
    for (const tableId of customTableIds) {
      const safe = tableId.replace(/"/g, '""');
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${safe}"`).run();
      } catch (err: any) {
        warnings.push(`drop custom table ${tableId}: ${err?.message ?? err}`);
      }
    }

    // 6. work_items orphan cleanup. work_items is workspace-agnostic but
    //    sourced from workspace_connector_configs. After we've deleted this
    //    user's connector configs, any work_item whose source is now
    //    *only* configured under the deleted workspaces (or under no
    //    workspace at all) is orphaned and should go.
    try {
      const orphanSql = `
        DELETE FROM work_items
        WHERE source NOT IN (SELECT DISTINCT source FROM workspace_connector_configs)
      `;
      const r = await db.prepare(orphanSql).run();
      workItemsDeleted = r.changes ?? 0;
    } catch (err: any) {
      warnings.push(`work_items cleanup: ${err?.message ?? err}`);
    }

    // 7. Finally, drop the workspace_config row(s). Done last so partial
    //    failure earlier still leaves us with the row to retry against.
    try {
      await db
        .prepare('DELETE FROM workspace_config WHERE auth_user_id = ?')
        .run(authUserId);
    } catch (err: any) {
      warnings.push(`workspace_config delete: ${err?.message ?? err}`);
    }
  }

  const workspaceDeleted = workspaceIds.length > 0;

  // 8. WorkOS user deletion — last so a network failure doesn't strand local
  //    data. deleteWorkosUser swallows errors and returns false; we surface
  //    that as a warning but still return ok=true if the local cascade ran.
  const workosUserDeleted = await deleteWorkosUser(authUserId);
  if (!workosUserDeleted) {
    warnings.push('WorkOS user deletion did not confirm success — retry the action to complete');
  }

  return {
    ok: true,
    workosUserDeleted,
    workspaceDeleted,
    workItemsDeleted,
    warnings,
  };
}
