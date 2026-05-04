import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

interface EpicRow {
  id: string;
  source_id: string; // Jira key e.g. "KAN-39"
  title: string;
  body: string | null;
  summary: string | null;
}

/**
 * Seed functional_units for every in-scope Jira epic.
 * item_type is stored lowercase ('epic') by the Atlassian adapter.
 * When projectKey is provided, only epics from that project are seeded.
 */
export async function seedJiraEpicAliases(
  workspaceId: string,
  projectKey: string | null,
): Promise<{ aliased: number }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // item_type stored as lowercase (atlassian.ts line 216: name?.toLowerCase())
  const epics = await db
    .prepare(
      `SELECT id, source_id, title, body, summary
       FROM work_items
       WHERE source = 'jira' AND item_type = 'epic'`,
    )
    .all<EpicRow>();

  // Filter by projectKey when provided — project key is the prefix of source_id
  const filtered = projectKey
    ? epics.filter((e) => e.source_id.split('-')[0].toUpperCase() === projectKey.toUpperCase())
    : epics;

  if (filtered.length === 0) return { aliased: 0 };

  let aliased = 0;
  for (const epic of filtered) {
    const epicKey = epic.source_id; // e.g. "KAN-39"
    const epicProjectKey = epicKey.split('-')[0].toUpperCase();
    const unitId = `epic:${epicKey}`;

    // Use body as description if present; fall back to summary; truncate to 1000 chars
    const rawDesc = epic.body ?? epic.summary ?? null;
    const description = rawDesc ? rawDesc.slice(0, 1000) : null;

    const result = await db
      .prepare(
        `INSERT INTO functional_units
           (id, workspace_id, project_key, name, description, status,
            detected_from, jira_epic_key, keywords, file_path_patterns,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 'jira_epic_alias', ?, '[]', '[]',
                 datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name        = excluded.name,
           description = excluded.description,
           -- preserve user-edited detected_from; only keep 'jira_epic_alias' if that's still the source
           detected_from = CASE
                             WHEN detected_from = 'jira_epic_alias' THEN 'jira_epic_alias'
                             ELSE detected_from
                           END,
           updated_at  = datetime('now')`,
      )
      .run(unitId, workspaceId, epicProjectKey, epic.title, description, epicKey);

    if (result.changes > 0) aliased++;
  }

  return { aliased };
}
