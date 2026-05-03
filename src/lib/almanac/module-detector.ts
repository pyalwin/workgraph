import { createHash } from 'crypto';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

// Noise path segments we skip during module prefix extraction
const NOISE_SEGMENTS = new Set(['node_modules', 'dist', '.next', '.turbo', '.cache']);

interface CodeEventRow {
  id: string;
  files_touched: string; // JSON string
  additions: number;
  deletions: number;
}

/**
 * Extract the 2-level path prefix used as the module name.
 * E.g. "src/lib/db/libsql.ts" -> "src/lib"
 *      "README.md"             -> "(root)"
 *      "src/index.ts"          -> "src"
 */
function extractPrefix(filePath: string): string | null {
  const parts = filePath.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  // Skip if any top-level segment is a noise directory
  if (NOISE_SEGMENTS.has(parts[0])) return null;
  if (parts.length === 1) return '(root)';
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Deterministic module ID: sha1 of "workspaceId:repo:prefix".
 * Lowercase hex — compact and sortable.
 */
function moduleId(workspaceId: string, repo: string, prefix: string): string {
  return createHash('sha1')
    .update(`${workspaceId}:${repo}:${prefix}`)
    .digest('hex');
}

export async function detectModulesForRepo(
  workspaceId: string,
  repo: string,
): Promise<{ modules_upserted: number; events_assigned: number }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Fetch all signal events for this repo
  const events = await db
    .prepare(
      `SELECT id, files_touched, additions, deletions
       FROM code_events
       WHERE workspace_id = ? AND repo = ? AND is_feature_evolution = 1`,
    )
    .all<CodeEventRow>(workspaceId, repo);

  if (events.length === 0) return { modules_upserted: 0, events_assigned: 0 };

  // Accumulate churn per prefix
  const prefixChurn = new Map<string, number>();

  // Build a per-event mapping: event id -> [prefix -> file count]
  const eventPrefixCounts = new Map<string, Map<string, number>>();

  for (const ev of events) {
    let files: string[];
    try {
      files = JSON.parse(ev.files_touched) as string[];
    } catch {
      files = [];
    }
    const churnPerFile = (ev.additions + ev.deletions) / Math.max(files.length, 1);
    const perEvent = new Map<string, number>();

    for (const f of files) {
      const prefix = extractPrefix(f);
      if (!prefix) continue;
      prefixChurn.set(prefix, (prefixChurn.get(prefix) ?? 0) + churnPerFile);
      perEvent.set(prefix, (perEvent.get(prefix) ?? 0) + 1);
    }

    if (perEvent.size > 0) {
      eventPrefixCounts.set(ev.id, perEvent);
    }
  }

  if (prefixChurn.size === 0) return { modules_upserted: 0, events_assigned: 0 };

  // UPSERT modules — preserve detected_from = 'manual' if already set
  for (const [prefix, churn] of prefixChurn) {
    const id = moduleId(workspaceId, repo, prefix);
    const pathPatterns = JSON.stringify([`${prefix}/**`]);

    await db
      .prepare(
        `INSERT INTO modules
           (id, workspace_id, repo, name, path_patterns, detected_from, churn,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'auto', ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name          = excluded.name,
           path_patterns = excluded.path_patterns,
           churn         = excluded.churn,
           -- preserve 'manual' label if a user already claimed it
           detected_from = CASE
                             WHEN detected_from = 'manual' THEN 'manual'
                             ELSE 'auto'
                           END,
           updated_at    = datetime('now')`,
      )
      .run(id, workspaceId, repo, prefix, pathPatterns, Math.round(churn));
  }

  // Assign each event to the module that covers the most of its files;
  // break ties alphabetically by prefix
  let eventsAssigned = 0;
  for (const ev of events) {
    const perEvent = eventPrefixCounts.get(ev.id);
    if (!perEvent || perEvent.size === 0) continue;

    // Pick prefix with highest file count; alphabetical on tie
    let bestPrefix = '';
    let bestCount = -1;
    for (const [prefix, count] of perEvent) {
      if (count > bestCount || (count === bestCount && prefix < bestPrefix)) {
        bestPrefix = prefix;
        bestCount = count;
      }
    }

    const id = moduleId(workspaceId, repo, bestPrefix);
    await db
      .prepare(`UPDATE code_events SET module_id = ? WHERE id = ?`)
      .run(id, ev.id);
    eventsAssigned++;
  }

  return { modules_upserted: prefixChurn.size, events_assigned: eventsAssigned };
}
