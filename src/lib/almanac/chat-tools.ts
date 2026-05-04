/**
 * Almanac · Chat tools (Phase 7 — KAN-49)
 *
 * Structured query tools for the Almanac data model. These are merged into
 * chatTools in src/lib/ai/chat-tools.ts.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

const initSchema = () => ensureSchemaAsync();
const getDb = () => getLibsqlDb();

// Only letters, numbers, spaces, hyphens, underscores allowed in user-supplied query text.
const QUERY_SAFE = /^[a-zA-Z0-9 _\-]+$/;

// ─── Types ────────────────────────────────────────────────────────────────────

interface FunctionalUnitRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  jira_epic_key: string | null;
  keywords: string | null;
  file_path_patterns: string | null;
  project_key: string;
  workspace_id: string;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const almanacTools = {

  getFunctionalUnit: tool({
    description:
      'Look up a functional unit (a logical module/feature area in the codebase) by name or id. ' +
      'Returns unit details and recent activity counts. Use when user mentions a feature area or component.',
    inputSchema: z.object({
      name: z.string().optional().describe('Case-insensitive name or alias'),
      id: z.string().optional().describe('Exact UUID of the functional unit'),
      projectKey: z.string().optional().describe('Jira project key to scope the search'),
    }),
    execute: async ({ name, id, projectKey }) => {
      await initSchema();
      const db = getDb();

      let unit: FunctionalUnitRow | undefined;
      if (id) {
        unit = await db
          .prepare(`SELECT * FROM functional_units WHERE id = ?`)
          .get<FunctionalUnitRow>(id) ?? undefined;
      } else if (name) {
        const lower = name.toLowerCase();
        unit = await db
          .prepare(
            `SELECT fu.* FROM functional_units fu
             WHERE LOWER(fu.name) = ?
               ${projectKey ? 'AND fu.project_key = ?' : ''}
             LIMIT 1`,
          )
          .get<FunctionalUnitRow>(...(projectKey ? [lower, projectKey] : [lower])) ?? undefined;

        if (!unit) {
          // Try aliases
          unit = await db
            .prepare(
              `SELECT fu.* FROM functional_units fu
               JOIN functional_unit_aliases fua ON fua.unit_id = fu.id
               WHERE LOWER(fua.alias) = ?
                 ${projectKey ? 'AND fu.project_key = ?' : ''}
               LIMIT 1`,
            )
            .get<FunctionalUnitRow>(...(projectKey ? [lower, projectKey] : [lower])) ?? undefined;
        }
      }

      if (!unit) return { found: false };

      const counts = await db
        .prepare(
          `SELECT
             COUNT(*) AS total_events,
             SUM(CASE WHEN ticket_link_status = 'unlinked' THEN 1 ELSE 0 END) AS unlinked_events,
             SUM(CASE WHEN is_feature_evolution = 1 THEN 1 ELSE 0 END) AS feature_events
           FROM code_events WHERE functional_unit_id = ?`,
        )
        .get<{ total_events: number; unlinked_events: number; feature_events: number }>(unit.id);

      return { found: true, unit, activity: counts ?? { total_events: 0, unlinked_events: 0, feature_events: 0 } };
    },
  }),

  listUnitEvolution: tool({
    description:
      'Show how a functional unit evolved over time, bucketed by month or week. ' +
      'Returns event counts, sample commit messages, SHAs, and authors per bucket. ' +
      'Use for "how did X change over time" or "what was the history of Y" questions.',
    inputSchema: z.object({
      unitId: z.string().describe('UUID of the functional unit'),
      since: z.string().optional().describe('ISO date lower bound, e.g. 2024-01-01'),
      until: z.string().optional().describe('ISO date upper bound'),
      granularity: z.enum(['month', 'week']).default('month'),
    }),
    execute: async ({ unitId, since, until, granularity }) => {
      await initSchema();
      const db = getDb();

      const fmt = granularity === 'week' ? '%Y-W%W' : '%Y-%m';
      const where: string[] = ['functional_unit_id = ?', 'is_feature_evolution = 1'];
      const params: (string | number)[] = [unitId];
      if (since) { where.push('occurred_at >= ?'); params.push(since); }
      if (until) { where.push('occurred_at <= ?'); params.push(until); }

      type EventRow = { sha: string; occurred_at: string; author_login: string | null; message: string };
      const events = await db
        .prepare(
          `SELECT sha, occurred_at, author_login, message
           FROM code_events WHERE ${where.join(' AND ')}
           ORDER BY occurred_at ASC`,
        )
        .all<EventRow>(...params);

      // Group into buckets
      const bucketMap = new Map<string, { shas: string[]; messages: string[]; authors: Set<string> }>();
      for (const e of events) {
        // Simple period label from occurred_at
        const d = new Date(e.occurred_at);
        let period: string;
        if (granularity === 'week') {
          // ISO week: year + week number
          const jan1 = new Date(d.getFullYear(), 0, 1);
          const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
          period = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
        } else {
          period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
        const b = bucketMap.get(period) ?? { shas: [], messages: [], authors: new Set<string>() };
        b.shas.push(e.sha.slice(0, 8));
        b.messages.push(e.message.slice(0, 80));
        if (e.author_login) b.authors.add(e.author_login);
        bucketMap.set(period, b);
      }

      const buckets = Array.from(bucketMap.entries())
        .slice(-24)
        .map(([period, b]) => ({
          period,
          event_count: b.shas.length,
          sample_shas: b.shas.slice(0, 3),
          sample_messages: b.messages.slice(0, 3),
          top_authors: Array.from(b.authors).slice(0, 3),
        }));

      return { unit_id: unitId, granularity, total_events: events.length, buckets };
    },
  }),

  getDriftForUnit: tool({
    description:
      'Find drift signals for a functional unit: commits shipped without a ticket, ' +
      'and "promised but not built" tickets (done-status tickets linked to unit with no matching commit). ' +
      'Use for "what shipped without a ticket" or "what was promised but never built" questions.',
    inputSchema: z.object({
      unitId: z.string().describe('UUID of the functional unit'),
    }),
    execute: async ({ unitId }) => {
      await initSchema();
      const db = getDb();

      type UnlinkedRow = { sha: string; occurred_at: string; message: string };
      const unlinked = await db
        .prepare(
          `SELECT sha, occurred_at, message FROM code_events
           WHERE functional_unit_id = ? AND ticket_link_status = 'unlinked'
           ORDER BY occurred_at DESC LIMIT 10`,
        )
        .all<UnlinkedRow>(unitId);

      const countRow = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM code_events
           WHERE functional_unit_id = ? AND ticket_link_status = 'unlinked'`,
        )
        .get<{ n: number }>(unitId);

      // Promised-but-not-built: linked work items with status='done'
      type LinkedItem = { source_id: string; title: string; status: string };
      const linkedDone = await db
        .prepare(
          `SELECT DISTINCT wi.source_id, wi.title, wi.status
           FROM code_events ce
           JOIN work_items wi ON wi.id = ce.linked_item_id
           WHERE ce.functional_unit_id = ? AND wi.status = 'done'
           LIMIT 10`,
        )
        .all<LinkedItem>(unitId);

      return {
        unit_id: unitId,
        unlinked_commit_count: countRow?.n ?? 0,
        sample_unlinked: unlinked.map((e) => ({
          sha: e.sha.slice(0, 8),
          occurred_at: e.occurred_at,
          message: e.message.slice(0, 100),
        })),
        promised_not_built_count: linkedDone.length,
        sample_promised: linkedDone,
      };
    },
  }),

  findUnitsByFile: tool({
    description:
      'Find which functional units are associated with a given file path. ' +
      'Useful for "what owns this file", "what team/area maintains path/to/file".',
    inputSchema: z.object({
      path: z.string().describe('File path (or partial path) to search for'),
    }),
    execute: async ({ path }) => {
      await initSchema();
      const db = getDb();

      type HitRow = { functional_unit_id: string; hit_count: number };
      const hits = await db
        .prepare(
          `SELECT functional_unit_id, COUNT(*) AS hit_count
           FROM code_events
           WHERE functional_unit_id IS NOT NULL
             AND files_touched LIKE ?
           GROUP BY functional_unit_id
           ORDER BY hit_count DESC
           LIMIT 5`,
        )
        .all<HitRow>(`%${path}%`);

      if (hits.length === 0) return { found: false, path, units: [] };

      const units = await Promise.all(
        hits.map(async (h) => {
          const u = await db
            .prepare(`SELECT id, name, description, status, project_key FROM functional_units WHERE id = ?`)
            .get<{ id: string; name: string; description: string | null; status: string; project_key: string }>(
              h.functional_unit_id,
            );
          return u ? { ...u, hit_count: h.hit_count } : null;
        }),
      );

      return { found: true, path, units: units.filter(Boolean) };
    },
  }),

  findUnitsByTicket: tool({
    description:
      'Find functional units that have code events linked to a given Jira ticket. ' +
      'Use when user asks "what code was written for ticket X" or "which area owns KAN-42".',
    inputSchema: z.object({
      jiraKey: z.string().describe('Jira issue key, e.g. KAN-42'),
    }),
    execute: async ({ jiraKey }) => {
      await initSchema();
      const db = getDb();

      // Resolve work item id from source_id
      const wi = await db
        .prepare(`SELECT id FROM work_items WHERE source_id = ? AND source = 'jira' LIMIT 1`)
        .get<{ id: string }>(jiraKey);

      if (!wi) return { found: false, jira_key: jiraKey, units: [] };

      type UnitHit = { unit_id: string; event_count: number };
      const unitHits = await db
        .prepare(
          `SELECT functional_unit_id AS unit_id, COUNT(*) AS event_count
           FROM code_events
           WHERE linked_item_id = ? AND functional_unit_id IS NOT NULL
           GROUP BY functional_unit_id
           ORDER BY event_count DESC
           LIMIT 10`,
        )
        .all<UnitHit>(wi.id);

      const units = await Promise.all(
        unitHits.map(async (h) => {
          const u = await db
            .prepare(`SELECT id, name, description, status, project_key FROM functional_units WHERE id = ?`)
            .get<{ id: string; name: string; description: string | null; status: string; project_key: string }>(
              h.unit_id,
            );
          return u ? { ...u, event_count: h.event_count } : null;
        }),
      );

      return { found: true, jira_key: jiraKey, work_item_id: wi.id, units: units.filter(Boolean) };
    },
  }),

  searchCommitHistory: tool({
    description:
      'Search commit history by keyword phrase. Returns matching commits ordered by recency. ' +
      'Supports optional author, date range, and result limit filters. ' +
      'Use for "find commits mentioning X", "what did @author ship last month", etc.',
    inputSchema: z.object({
      query: z.string().describe('Search phrase (letters, numbers, spaces, hyphens, underscores only)'),
      author: z.string().optional().describe('Filter by author_login'),
      since: z.string().optional().describe('ISO date lower bound'),
      until: z.string().optional().describe('ISO date upper bound'),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    execute: async ({ query, author, since, until, limit }) => {
      // Sanitise user-controlled text before LIKE interpolation.
      if (!QUERY_SAFE.test(query)) {
        return { error: 'invalid query — only letters, numbers, spaces, hyphens, and underscores allowed' };
      }

      await initSchema();
      const db = getDb();

      const where: string[] = [`(message LIKE ? OR LOWER(message) LIKE LOWER(?))`];
      const params: (string | number)[] = [`%${query}%`, `%${query}%`];

      if (author) { where.push('author_login = ?'); params.push(author); }
      if (since) { where.push('occurred_at >= ?'); params.push(since); }
      if (until) { where.push('occurred_at <= ?'); params.push(until); }

      params.push(limit ?? 15);

      type EventRow = {
        sha: string; occurred_at: string; author_login: string | null;
        message: string; repo: string; pr_number: number | null;
        files_touched: string | null; intent: string | null;
      };
      const rows = await db
        .prepare(
          `SELECT sha, occurred_at, author_login, message, repo, pr_number, files_touched, intent
           FROM code_events
           WHERE ${where.join(' AND ')}
           ORDER BY occurred_at DESC
           LIMIT ?`,
        )
        .all<EventRow>(...params);

      const events = rows.map((e) => ({
        sha: e.sha.slice(0, 8),
        occurred_at: e.occurred_at,
        author: e.author_login,
        message: e.message.slice(0, 120),
        repo: e.repo,
        pr_number: e.pr_number,
        files_touched_count: e.files_touched
          ? (() => { try { return (JSON.parse(e.files_touched!) as unknown[]).length; } catch { return null; } })()
          : null,
        intent: e.intent,
      }));

      return { query, count: events.length, events };
    },
  }),
} as const;

export type AlmanacTools = typeof almanacTools;
