import { tool } from 'ai';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { searchChunks } from '@/lib/embeddings/embed';
import { getProjectDetail, getProjectSummaryCards } from '@/lib/project-queries';
import { listDecisions } from '@/lib/decision/extract';

// Local helpers — initSchema/getDb are removed; substitute with the async pair.
const initSchema = async () => ensureSchemaAsync();
const getDb = () => getLibsqlDb();

const PROJECT_NAMES: Record<string, string> = {
  ALPHA: 'Alpha Initiative',
  BETA: 'Beta Platform',
  GAMMA: 'Gamma Workflow',
};

function findProjectKey(query: string): string | null {
  const q = query.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!q) return null;
  for (const [key, name] of Object.entries(PROJECT_NAMES)) {
    const k = key.toLowerCase();
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (q === k || q === n || n.includes(q) || q.includes(k)) return key;
  }
  return null;
}

const SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex)\b/i;

export const chatTools = {
  // ───── Structured queries ─────

  countItems: tool({
    description:
      'Count work_items matching optional filters. Use for "how many" questions about Jira tickets, GitHub items, etc. Sources: jira, github, slack, granola, notion, manual. Item types vary by source (e.g. task, bug, story for jira).',
    inputSchema: z.object({
      source: z.string().optional().describe('e.g. jira, github, slack'),
      item_type: z.string().optional().describe('e.g. task, bug, story, repository, release, note'),
      status: z.string().optional().describe('e.g. open, in_progress, done, closed'),
    }),
    execute: async ({ source, item_type, status }) => {
      await initSchema();
      const db = getDb();
      const where: string[] = [];
      const params: (string | number | null)[] = [];
      if (source) { where.push('source = ?'); params.push(source); }
      if (item_type) { where.push('item_type = ?'); params.push(item_type); }
      if (status) { where.push('status = ?'); params.push(status); }
      const sql = `SELECT COUNT(*) AS c FROM work_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
      const row = await db.prepare(sql).get(...params) as { c: number };
      return { count: row.c, filters: { source, item_type, status } };
    },
  }),

  listItems: tool({
    description:
      'List work_items matching filters. Returns id, title, source, item_type, status, url. Use after countItems when the user wants to see specific items.',
    inputSchema: z.object({
      source: z.string().optional(),
      item_type: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    execute: async ({ source, item_type, status, limit }) => {
      await initSchema();
      const db = getDb();
      const where: string[] = [];
      const params: (string | number | null)[] = [];
      if (source) { where.push('source = ?'); params.push(source); }
      if (item_type) { where.push('item_type = ?'); params.push(item_type); }
      if (status) { where.push('status = ?'); params.push(status); }
      const sql = `SELECT id, source, source_id, item_type, title, status, url, created_at, updated_at
                   FROM work_items
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY COALESCE(updated_at, created_at) DESC
                   LIMIT ?`;
      const rows = await db.prepare(sql).all(...params, limit ?? 15) as Array<Record<string, unknown>>;
      return { count: rows.length, items: rows };
    },
  }),

  groupItems: tool({
    description:
      'Aggregate work_items count grouped by a column. Useful for breakdowns (e.g. tickets by status, items by source).',
    inputSchema: z.object({
      groupBy: z.enum(['source', 'item_type', 'status', 'priority']),
      source: z.string().optional(),
    }),
    execute: async ({ groupBy, source }) => {
      await initSchema();
      const db = getDb();
      const sourceClause = source ? 'WHERE source = ?' : '';
      const sql = `SELECT ${groupBy} AS bucket, COUNT(*) AS c
                   FROM work_items ${sourceClause}
                   GROUP BY ${groupBy}
                   ORDER BY c DESC`;
      const rows = (source
        ? await db.prepare(sql).all<{ bucket: string; c: number }>(source)
        : await db.prepare(sql).all<{ bucket: string; c: number }>());
      return { groupBy, rows };
    },
  }),

  // ───── PRs (live in issue_trails, not work_items) ─────

  countPRs: tool({
    description:
      'Count GitHub PRs from issue_trails. PRs are NOT in work_items — they are trail entries. Use this for any PR count question. State values: open, merged, closed, approved, changes_requested.',
    inputSchema: z.object({
      state: z.string().optional().describe('Filter by latest state: open, merged, closed'),
      matched: z.enum(['matched', 'unmatched', 'ai_matched', 'any']).default('any'),
    }),
    execute: async ({ state, matched }) => {
      await initSchema();
      const db = getDb();
      const matchClause =
        matched && matched !== 'any' ? 'AND match_status = ?' : '';
      // Latest event per PR ref
      const sql = `
        WITH latest AS (
          SELECT pr_ref, state, match_status,
            ROW_NUMBER() OVER (PARTITION BY pr_ref ORDER BY occurred_at DESC) AS rn
          FROM issue_trails
          WHERE kind LIKE 'pr_%'
        )
        SELECT COUNT(*) AS c FROM latest
        WHERE rn = 1
          ${state ? 'AND state = ?' : ''}
          ${matchClause}
      `;
      const params: (string | number | null)[] = [];
      if (state) params.push(state);
      if (matched && matched !== 'any') params.push(matched);
      const row = await db.prepare(sql).get(...params) as { c: number };
      return { count: row.c, state, matched };
    },
  }),

  listPRs: tool({
    description:
      'List PRs (latest event per PR) from issue_trails with state filter.',
    inputSchema: z.object({
      state: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    execute: async ({ state, limit }) => {
      await initSchema();
      const db = getDb();
      const sql = `
        WITH latest AS (
          SELECT pr_ref, pr_url, repo, state, actor, title, occurred_at,
            ROW_NUMBER() OVER (PARTITION BY pr_ref ORDER BY occurred_at DESC) AS rn
          FROM issue_trails
          WHERE kind LIKE 'pr_%'
        )
        SELECT pr_ref, pr_url, repo, state, actor, title, occurred_at
        FROM latest
        WHERE rn = 1 ${state ? 'AND state = ?' : ''}
        ORDER BY occurred_at DESC
        LIMIT ?
      `;
      const rows = (state
        ? await db.prepare(sql).all<Record<string, unknown>>(state, limit ?? 15)
        : await db.prepare(sql).all<Record<string, unknown>>(limit ?? 15));
      return { count: rows.length, prs: rows };
    },
  }),

  // ───── Projects ─────

  listProjects: tool({
    description:
      'List all projects with health, completion, velocity, and PR/ticket counts. ALWAYS call this first when the user mentions a project by name (e.g. "ALPHA", "BETA").',
    inputSchema: z.object({
      period: z.enum(['30d', '90d', 'all']).default('30d'),
    }),
    execute: async ({ period }) => {
      await initSchema();
      const cards = await getProjectSummaryCards(period ?? '30d');
      return {
        count: cards.length,
        projects: cards.map((c) => ({
          key: c.key,
          name: c.name,
          health: c.health_status,
          summary_snippet: c.summary_snippet,
          completion_pct: c.completion_pct,
          completion_total: c.completion_total,
          velocity: c.velocity,
          open_count: c.open_count,
          stale_count: c.stale_count,
          pr_count: c.pr_count,
        })),
      };
    },
  }),

  findProject: tool({
    description:
      'Resolve a project name or partial name to its key. Use whenever the user references a project by name.',
    inputSchema: z.object({
      query: z.string().min(1),
    }),
    execute: async ({ query }) => {
      const key = findProjectKey(query);
      if (!key) {
        return { found: false, query, available: Object.entries(PROJECT_NAMES).map(([k, n]) => ({ key: k, name: n })) };
      }
      return { found: true, key, name: PROJECT_NAMES[key] };
    },
  }),

  getProject: tool({
    description:
      'Fetch full detail for one project: tickets, OKRs, action items, anomalies. Pass projectKey from listProjects/findProject.',
    inputSchema: z.object({
      projectKey: z.string(),
      period: z.enum(['30d', '90d', 'all']).default('30d'),
    }),
    execute: async ({ projectKey, period }) => {
      await initSchema();
      const detail = await getProjectDetail(projectKey, period ?? '30d');
      return {
        project: detail.project,
        health: detail.health,
        ticket_count: detail.tickets.length,
        tickets_by_status: detail.tickets.reduce<Record<string, number>>((acc, t) => {
          acc[t.status] = (acc[t.status] ?? 0) + 1;
          return acc;
        }, {}),
        recent_tickets: detail.tickets.slice(0, 10).map((t) => ({
          source_id: t.source_id,
          title: t.title,
          status: t.status,
        })),
        action_items: detail.actionItems?.slice(0, 8) ?? [],
        anomalies: detail.anomalies?.slice(0, 5) ?? [],
        okrs: detail.okrs?.slice(0, 5) ?? [],
      };
    },
  }),

  // ───── Decisions ─────

  listDecisions: tool({
    description:
      'List recent decisions extracted from meetings/discussions. Use when the user asks what was decided or about rationale.',
    inputSchema: z.object({}),
    execute: async () => {
      await initSchema();
      const decisions = await listDecisions();
      return {
        count: decisions.length,
        decisions: decisions.slice(0, 20).map((d) => ({
          id: d.id,
          title: d.title,
          decided_at: d.decided_at,
          summary: d.summary,
        })),
      };
    },
  }),

  // ───── Semantic search (last resort, content-based) ─────

  searchKnowledge: tool({
    description:
      'Semantic search across ingested content (Jira bodies, PR descriptions, meeting notes, Slack threads). Use ONLY for content/topic questions ("what was discussed about X", "find docs about Y") — NOT for counts, status filters, or project-name lookups.',
    inputSchema: z.object({
      query: z.string().min(2),
      k: z.number().int().min(1).max(20).default(8),
    }),
    execute: async ({ query, k }) => {
      await initSchema();
      const hits = await searchChunks(query, k ?? 8);
      const db = getDb();
      const itemSql = `SELECT id, title, source, source_id, item_type, status, url, created_at FROM work_items WHERE id = ?`;
      const best = new Map<string, typeof hits[0]>();
      for (const h of hits) {
        const prev = best.get(h.item_id);
        if (!prev || h.distance < prev.distance) best.set(h.item_id, h);
      }
      const results: Array<Record<string, unknown>> = [];
      for (const [itemId, hit] of best) {
        const item = await db.prepare(itemSql).get<Record<string, unknown>>(itemId);
        if (!item) continue;
        results.push({
          ...item,
          excerpt: hit.chunk_text.length > 280 ? hit.chunk_text.slice(0, 280) + '…' : hit.chunk_text,
          distance: Number(hit.distance.toFixed(4)),
        });
      }
      return { count: results.length, results };
    },
  }),

  // ───── Schema introspection (the AI's "what's available" map) ─────

  describeSchema: tool({
    description:
      'Introspect the Workgraph SQLite database. Without args: lists all tables with their column names and row counts. With table arg: returns full CREATE TABLE SQL, columns (name/type/notnull/pk), index list, and a 2-row sample. ALWAYS call this first when planning a runQuery against unfamiliar tables.',
    inputSchema: z.object({
      table: z.string().optional().describe('Optional table name for detailed info'),
    }),
    execute: async ({ table }) => {
      await initSchema();
      const db = getDb();
      if (!table) {
        const tables = await db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type='table'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE 'vec_%'
             ORDER BY name`,
          )
          .all<{ name: string }>();
        const tablesOut = await Promise.all(
          tables.map(async (t) => {
            const cols = await db.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>();
            const countRow = await db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get<{ c: number }>();
            return {
              name: t.name,
              columns: cols.map((c) => c.name),
              row_count: countRow?.c ?? 0,
            };
          }),
        );
        return { tables: tablesOut };
      }
      // Validate the table name to avoid injection in PRAGMA / sample query
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return { error: 'invalid table name' };
      }
      const exists = await db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .get<{ sql: string }>(table);
      if (!exists) return { error: `table '${table}' not found` };
      const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
      const indexes = await db.prepare(`PRAGMA index_list(${table})`).all();
      const sample = await db.prepare(`SELECT * FROM ${table} LIMIT 2`).all();
      return {
        table,
        create_sql: exists.sql,
        columns: cols,
        indexes,
        sample,
      };
    },
  }),

  // ───── Row fetch by id ─────

  getById: tool({
    description:
      'Fetch a single row from any whitelisted table by id or source_id. Tables: work_items, issue_trails, decisions, action_items, anomalies, workstreams, projects, project_summaries, chat_threads, goals.',
    inputSchema: z.object({
      table: z.enum([
        'work_items',
        'issue_trails',
        'decisions',
        'action_items',
        'anomalies',
        'workstreams',
        'projects',
        'project_summaries',
        'chat_threads',
        'goals',
      ]),
      id: z.string().describe('id (uuid) or source_id for work_items'),
    }),
    execute: async ({ table, id }) => {
      await initSchema();
      const db = getDb();
      let row: unknown;
      if (table === 'work_items') {
        row = await db
          .prepare(`SELECT * FROM work_items WHERE id = ? OR source_id = ? LIMIT 1`)
          .get(id, id);
      } else {
        row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(id);
      }
      if (!row) return { found: false };
      return { found: true, table, row };
    },
  }),

  // ───── Graph traversal ─────

  getRelatedItems: tool({
    description:
      'Find work_items linked to a given item via the `links` table. Useful for "what blocks this", "what does this depend on", "what duplicates this". Returns both directions of the link.',
    inputSchema: z.object({
      itemId: z.string(),
      linkType: z
        .string()
        .optional()
        .describe('Optional filter, e.g. blocks, depends_on, duplicates, related_to'),
    }),
    execute: async ({ itemId, linkType }) => {
      await initSchema();
      const db = getDb();
      const typeClause = linkType ? 'AND link_type = ?' : '';
      const outgoingSql = `
        SELECT l.link_type, l.confidence, w.id, w.source, w.source_id, w.item_type, w.title, w.status
        FROM links l
        JOIN work_items w ON w.id = l.target_item_id
        WHERE l.source_item_id = ? ${typeClause}
        LIMIT 30
      `;
      const incomingSql = `
        SELECT l.link_type, l.confidence, w.id, w.source, w.source_id, w.item_type, w.title, w.status
        FROM links l
        JOIN work_items w ON w.id = l.source_item_id
        WHERE l.target_item_id = ? ${typeClause}
        LIMIT 30
      `;
      const outgoing = linkType
        ? await db.prepare(outgoingSql).all<Record<string, unknown>>(itemId, linkType)
        : await db.prepare(outgoingSql).all<Record<string, unknown>>(itemId);
      const incoming = linkType
        ? await db.prepare(incomingSql).all<Record<string, unknown>>(itemId, linkType)
        : await db.prepare(incomingSql).all<Record<string, unknown>>(itemId);
      return { outgoing, incoming };
    },
  }),

  // ───── SQL escape hatch (read-only) ─────

  runQuery: tool({
    description: `Execute a read-only SQLite SELECT against the Workgraph DB.

WHEN TO USE: any question that none of the structured tools cover — joins, custom aggregations, time-series, fuzzy LIKE matching, etc.

WORKFLOW:
1. If you don't know the schema, call describeSchema() first to list all tables.
2. Call describeSchema(table) to inspect columns/indexes/sample rows for the table you care about.
3. Then write a focused SELECT.

Rules:
- SELECT/WITH only. INSERT/UPDATE/DELETE/DDL will be rejected.
- Always include explicit LIMIT (max 100).
- Project specific columns — don't use SELECT *.
- For text search, prefer searchKnowledge over LIKE %x%.
`,
    inputSchema: z.object({
      sql: z.string().min(10),
    }),
    execute: async ({ sql }) => {
      await initSchema();
      const trimmed = sql.trim().replace(/;+\s*$/, '');
      if (!/^\s*select\s|^\s*with\s/i.test(trimmed)) {
        return { error: 'Only SELECT/WITH queries allowed' };
      }
      if (SQL_FORBIDDEN.test(trimmed)) {
        return { error: 'Query contains forbidden keyword' };
      }
      if (!/\blimit\b/i.test(trimmed)) {
        return { error: 'Query must include an explicit LIMIT (max 100)' };
      }
      const db = getDb();
      try {
        const rows = await db.prepare(trimmed).all() as Array<Record<string, unknown>>;
        if (rows.length > 100) {
          return { error: 'Result exceeded 100 rows; tighten your LIMIT/WHERE' };
        }
        return { count: rows.length, rows };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  }),

  // ───── Mutation ─────

  createNote: tool({
    description: 'Save a manual note as a work_item when the user asks to save/jot/capture/note something.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string().optional(),
    }),
    execute: async ({ title, body }) => {
      await initSchema();
      const db = getDb();
      const id = uuid();
      const now = new Date().toISOString();
      const sourceId = `note-${id.slice(0, 8)}`;
      await db
        .prepare(
          `INSERT INTO work_items (id, source, source_id, item_type, title, body, status, created_at, updated_at, synced_at)
           VALUES (?, 'manual', ?, 'note', ?, ?, 'open', ?, ?, datetime('now'))`,
        )
        .run(id, sourceId, title.trim(), body?.trim() || null, now, now);
      return { id, source_id: sourceId, title };
    },
  }),
} as const;

export type ChatTools = typeof chatTools;
