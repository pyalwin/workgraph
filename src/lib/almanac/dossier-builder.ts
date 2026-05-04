/**
 * Almanac · Dossier Builder (Phase 4 — KAN-46)
 *
 * Builds per-unit and per-project dossiers from DB data only.
 * No git access — all data comes from code_events, file_lifecycle,
 * functional_units, work_items, issue_decisions, etc.
 *
 * Caps:
 *   events   → 12 (first + last + top-10 middle by churn)
 *   files    → 50 (highest churn)
 *   tickets  → 30 (chronological)
 *   decisions→ 20 (chronological)
 */
import { getLibsqlDb } from '@/lib/db/libsql';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

// ─── Exported interfaces ─────────────────────────────────────────────────────

export interface DossierEvent {
  sha: string;
  pr_number: number | null;
  occurred_at: string;
  author: string | null;
  message: string;
  files_count: number;
  additions: number;
  deletions: number;
  intent: string | null;
  significance: string | null;
  ticket_key: string | null;
  role: 'first' | 'milestone' | 'last';
}

export interface DossierFile {
  path: string;
  status: 'extant' | 'deleted' | 'renamed';
  churn: number;
  first_at: string | null;
  last_at: string | null;
}

export interface DossierTicket {
  item_id: string;
  source_id: string;
  title: string;
  status: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

export interface DossierDecision {
  id: string;
  text: string;
  rationale: string | null;
  decided_at: string | null;
  trail_id: string | null;
}

export interface UnitDossier {
  unit_id: string;
  unit_name: string;
  unit_description: string | null;
  keywords: string[];
  jira_epic_key: string | null;
  first_seen_at: string | null;
  last_active_at: string | null;
  events: DossierEvent[];
  files: DossierFile[];
  tickets: DossierTicket[];
  decisions: DossierDecision[];
  counts: {
    total_events: number;
    signal_events: number;
    files_extant: number;
    files_deleted: number;
    tickets_linked: number;
  };
}

export interface ProjectDossier {
  project_key: string;
  unit_count: number;
  total_signal_events: number;
  drift_unticketed: number;
  drift_unbuilt: number;
  decisions: DossierDecision[];
  units_summary: { unit_id: string; name: string; signal_events: number }[];
  cross_project_tickets: number;
}

// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface UnitRow {
  id: string;
  name: string | null;
  description: string | null;
  keywords: string;
  jira_epic_key: string | null;
  first_seen_at: string | null;
  last_active_at: string | null;
}

interface EventRow {
  sha: string;
  pr_number: number | null;
  occurred_at: string;
  author_login: string | null;
  author_email: string | null;
  message: string | null;
  files_touched: string;
  additions: number;
  deletions: number;
  intent: string | null;
  architectural_significance: string | null;
  linked_item_id: string | null;
  ticket_source_id: string | null;
}

interface FileRow {
  path: string;
  status: string;
  churn: number;
  first_at: string | null;
  last_at: string | null;
}

interface TicketRow {
  item_id: string;
  source_id: string;
  title: string | null;
  status: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

interface DecisionRow {
  id: string;
  text: string;
  rationale: string | null;
  decided_at: string | null;
  trail_id: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Select milestone events from a full list.
 * Rules: first + last + up to 10 middle sorted by (additions + deletions) DESC.
 * If total <= 12, return all with appropriate roles.
 */
function selectMilestoneEvents(rows: EventRow[]): DossierEvent[] {
  if (rows.length === 0) return [];

  const toEvent = (r: EventRow, role: DossierEvent['role']): DossierEvent => {
    let filesCount = 0;
    try { filesCount = (JSON.parse(r.files_touched) as unknown[]).length; } catch { /* empty */ }
    return {
      sha: r.sha,
      pr_number: r.pr_number,
      occurred_at: r.occurred_at,
      author: r.author_login ?? r.author_email ?? null,
      message: r.message ?? '',
      files_count: filesCount,
      additions: r.additions,
      deletions: r.deletions,
      intent: r.intent,
      significance: r.architectural_significance,
      ticket_key: r.ticket_source_id ?? null,
      role,
    };
  };

  if (rows.length <= 12) {
    return rows.map((r, i) => {
      const role: DossierEvent['role'] =
        i === 0 ? 'first' : i === rows.length - 1 ? 'last' : 'milestone';
      return toEvent(r, role);
    });
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const middle = rows
    .slice(1, rows.length - 1)
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, 10)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  return [
    toEvent(first, 'first'),
    ...middle.map((r) => toEvent(r, 'milestone')),
    toEvent(last, 'last'),
  ];
}

// ─── buildDossier ─────────────────────────────────────────────────────────────

export async function buildDossier(
  workspaceId: string,
  projectKey: string,
  unitId: string,
): Promise<UnitDossier> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // 1. Unit metadata
  const unit = await db
    .prepare(
      `SELECT id, name, description, keywords, jira_epic_key, first_seen_at, last_active_at
       FROM functional_units
       WHERE id = ? AND workspace_id = ?`,
    )
    .get<UnitRow>(unitId, workspaceId);

  if (!unit) {
    throw new Error(`Unit ${unitId} not found in workspace ${workspaceId}`);
  }

  // 2. All signal events for this unit (chronological)
  const allEvents = await db
    .prepare(
      `SELECT ce.sha, ce.pr_number, ce.occurred_at,
              ce.author_login, ce.author_email, ce.message,
              ce.files_touched, ce.additions, ce.deletions,
              ce.intent, ce.architectural_significance, ce.linked_item_id,
              wi.source_id AS ticket_source_id
       FROM code_events ce
       LEFT JOIN work_items wi ON wi.id = ce.linked_item_id
       WHERE ce.functional_unit_id = ?
         AND ce.is_feature_evolution = 1
       ORDER BY ce.occurred_at ASC`,
    )
    .all<EventRow>(unitId);

  const totalEvents = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM code_events WHERE functional_unit_id = ?`)
    .get<{ cnt: number }>(unitId);

  // 3. File lifecycle — union of all paths across unit events
  const allPaths = new Set<string>();
  for (const ev of allEvents) {
    try {
      const paths = JSON.parse(ev.files_touched) as string[];
      for (const p of paths) allPaths.add(p);
    } catch { /* skip */ }
  }

  let files: DossierFile[] = [];
  if (allPaths.size > 0) {
    // Batch lookup — SQLite IN clause
    const pathList = [...allPaths].slice(0, 200); // safety cap before file-level cap
    const placeholders = pathList.map(() => '?').join(',');
    const fileRows = await db
      .prepare(
        `SELECT path, status, churn, first_at, last_at
         FROM file_lifecycle
         WHERE path IN (${placeholders})`,
      )
      .all<FileRow>(...pathList);

    files = fileRows
      .map((r) => ({
        path: r.path,
        status: (r.status === 'deleted' ? 'deleted' : r.status === 'renamed' ? 'renamed' : 'extant') as DossierFile['status'],
        churn: r.churn,
        first_at: r.first_at,
        last_at: r.last_at,
      }))
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 50);
  }

  // 4. Linked tickets
  const linkedItemIds = [...new Set(allEvents.filter((e) => e.linked_item_id).map((e) => e.linked_item_id as string))];
  let tickets: DossierTicket[] = [];
  if (linkedItemIds.length > 0) {
    const placeholders = linkedItemIds.map(() => '?').join(',');
    const ticketRows = await db
      .prepare(
        `SELECT DISTINCT id AS item_id, source_id, title, status, created_at,
                updated_at AS resolved_at
         FROM work_items
         WHERE id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all<TicketRow>(...linkedItemIds);
    tickets = ticketRows
      .map((r) => ({
        item_id: r.item_id,
        source_id: r.source_id,
        title: r.title ?? '',
        status: r.status,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
      }))
      .slice(0, 30);
  }

  // 5. Decisions from linked tickets
  let decisions: DossierDecision[] = [];
  if (linkedItemIds.length > 0) {
    const placeholders = linkedItemIds.map(() => '?').join(',');
    const decisionRows = await db
      .prepare(
        `SELECT id, text, rationale, decided_at, trail_id
         FROM issue_decisions
         WHERE issue_item_id IN (${placeholders})
         ORDER BY decided_at ASC`,
      )
      .all<DecisionRow>(...linkedItemIds);
    decisions = decisionRows.slice(0, 20);
  }

  // 6. Counts
  const filesExtant = files.filter((f) => f.status === 'extant').length;
  const filesDeleted = files.filter((f) => f.status === 'deleted').length;

  let keywords: string[] = [];
  try { keywords = JSON.parse(unit.keywords) as string[]; } catch { /* empty */ }

  return {
    unit_id: unit.id,
    unit_name: unit.name ?? unit.id,
    unit_description: unit.description,
    keywords,
    jira_epic_key: unit.jira_epic_key,
    first_seen_at: unit.first_seen_at,
    last_active_at: unit.last_active_at,
    events: selectMilestoneEvents(allEvents),
    files,
    tickets,
    decisions,
    counts: {
      total_events: totalEvents?.cnt ?? 0,
      signal_events: allEvents.length,
      files_extant: filesExtant,
      files_deleted: filesDeleted,
      tickets_linked: tickets.length,
    },
  };
}

// ─── buildProjectDossier ──────────────────────────────────────────────────────

export async function buildProjectDossier(
  workspaceId: string,
  projectKey: string,
): Promise<ProjectDossier> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // All units for this project
  const unitRows = await db
    .prepare(
      `SELECT id, name, description, keywords, jira_epic_key, first_seen_at, last_active_at
       FROM functional_units
       WHERE workspace_id = ? AND project_key = ? AND status = 'active'`,
    )
    .all<UnitRow>(workspaceId, projectKey);

  // Signal events per unit
  const unitSummaries: ProjectDossier['units_summary'] = [];
  let totalSignalEvents = 0;

  for (const u of unitRows) {
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM code_events
         WHERE functional_unit_id = ? AND is_feature_evolution = 1`,
      )
      .get<{ cnt: number }>(u.id);
    const signalCount = cnt?.cnt ?? 0;
    totalSignalEvents += signalCount;
    unitSummaries.push({ unit_id: u.id, name: u.name ?? u.id, signal_events: signalCount });
  }

  // Drift — signal events with no ticket link
  const unticketedRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM code_events ce
       WHERE ce.workspace_id = ?
         AND ce.is_feature_evolution = 1
         AND ce.ticket_link_status = 'unlinked'
         AND ce.functional_unit_id IN (
           SELECT id FROM functional_units WHERE project_key = ? AND workspace_id = ?
         )`,
    )
    .get<{ cnt: number }>(workspaceId, projectKey, workspaceId);
  const driftUnticketed = unticketedRow?.cnt ?? 0;

  // Drift — tickets done with no linked code_events
  const unbuiltRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.status = 'done'
         AND json_extract(wi.metadata, '$.entity_key') = ?
         AND NOT EXISTS (
           SELECT 1 FROM code_events ce WHERE ce.linked_item_id = wi.id
         )`,
    )
    .get<{ cnt: number }>(projectKey);
  const driftUnbuilt = unbuiltRow?.cnt ?? 0;

  // Project-wide decisions (from all linked tickets for the project)
  const projectLinkedItemIds = await db
    .prepare(
      `SELECT DISTINCT ce.linked_item_id
       FROM code_events ce
       WHERE ce.workspace_id = ?
         AND ce.linked_item_id IS NOT NULL
         AND ce.functional_unit_id IN (
           SELECT id FROM functional_units WHERE project_key = ? AND workspace_id = ?
         )`,
    )
    .all<{ linked_item_id: string }>(workspaceId, projectKey, workspaceId);

  let allDecisions: DossierDecision[] = [];
  const itemIds = projectLinkedItemIds.map((r) => r.linked_item_id);
  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',');
    const decisionRows = await db
      .prepare(
        `SELECT id, text, rationale, decided_at, trail_id
         FROM issue_decisions
         WHERE issue_item_id IN (${placeholders})
         ORDER BY decided_at ASC`,
      )
      .all<DecisionRow>(...itemIds);
    allDecisions = decisionRows.slice(0, 20);
  }

  // Cross-project tickets: work_items where source_id prefix matches projectKey
  // but the ticket is linked to a unit in a DIFFERENT project
  const crossProjectRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.source_id LIKE ?`,
    )
    .get<{ cnt: number }>(`${projectKey}-%`);
  const crossProjectTickets = crossProjectRow?.cnt ?? 0;

  return {
    project_key: projectKey,
    unit_count: unitRows.length,
    total_signal_events: totalSignalEvents,
    drift_unticketed: driftUnticketed,
    drift_unbuilt: driftUnbuilt,
    decisions: allDecisions,
    units_summary: unitSummaries,
    cross_project_tickets: crossProjectTickets,
  };
}
