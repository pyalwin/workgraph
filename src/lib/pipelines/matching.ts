/**
 * Pipeline-link matching — Phase D of founder-workspace spec (section 4.2).
 *
 * Given a freshly-ingested work_item from gmail/gcal/gdrive, return candidate
 * (pipeline_table, pipeline_row_id) matches. Domain/email/title heuristics
 * only — no vector similarity in v1.
 *
 * The caller (sync persistence hook) is responsible for INSERT OR IGNORE'ing
 * the returned matches into pipeline_links and recomputing last_touch.
 */

import { getLibsqlDb } from '../db/libsql';

export type PipelineTable = 'deals' | 'investors' | 'people';
export type PipelineMatchReason = 'domain_match' | 'email_match' | 'title_match' | 'manual';

export interface PipelineMatch {
  table: PipelineTable;
  rowId: string;
  reason: PipelineMatchReason;
  confidence: number;
}

interface MatchItem {
  source: string;
  source_id: string;
  title: string;
  metadata: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function extractEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim().toLowerCase();
    if (EMAIL_RE.test(trimmed)) out.push(trimmed);
  }
  return out;
}

function emailsToDomains(emails: string[]): string[] {
  const set = new Set<string>();
  for (const e of emails) {
    const at = e.lastIndexOf('@');
    if (at < 0) continue;
    const dom = e.slice(at + 1);
    if (dom) set.add(dom);
  }
  return Array.from(set);
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Upsert a match into the accumulator, taking the max confidence per
 * (table, rowId) and preferring the more specific reason if confidence ties.
 */
function addMatch(
  acc: Map<string, PipelineMatch>,
  table: PipelineTable,
  rowId: string,
  reason: PipelineMatchReason,
  confidence: number,
): void {
  const key = `${table}::${rowId}`;
  const next: PipelineMatch = { table, rowId, reason, confidence: clamp01(confidence) };
  const prev = acc.get(key);
  if (!prev) {
    acc.set(key, next);
    return;
  }
  if (next.confidence > prev.confidence) {
    acc.set(key, next);
  }
}

function boostMatch(
  acc: Map<string, PipelineMatch>,
  table: PipelineTable,
  rowId: string,
  delta: number,
): void {
  const key = `${table}::${rowId}`;
  const prev = acc.get(key);
  if (!prev) return;
  prev.confidence = clamp01(prev.confidence + delta);
}

/**
 * Query each pipeline table for rows whose indexed lookup column matches one
 * of the candidate domains/emails. Wrapped in try/catch so missing tables
 * (workspace doesn't have the founder preset) are non-fatal.
 */
async function queryMatches(args: {
  domains: string[];
  emails: string[];
  matchDealsByDomain: boolean;
  dealsConfidence: number;
  investorsConfidence: number;
  candidatesConfidence: number;
}): Promise<{
  deals: { id: string; domain: string }[];
  investors: { id: string; partner_email: string }[];
  candidates: { id: string; email: string }[];
}> {
  const db = getLibsqlDb();
  const out = {
    deals: [] as { id: string; domain: string }[],
    investors: [] as { id: string; partner_email: string }[],
    candidates: [] as { id: string; email: string }[],
  };

  if (args.matchDealsByDomain && args.domains.length > 0) {
    try {
      const rows = await db
        .prepare(
          `SELECT id, domain FROM deals WHERE LOWER(domain) IN (${placeholders(args.domains.length)})`,
        )
        .all<{ id: string; domain: string }>(...args.domains);
      out.deals = rows ?? [];
    } catch {
      // table missing — workspace doesn't have founder preset
    }
  }

  if (args.emails.length > 0) {
    try {
      const rows = await db
        .prepare(
          `SELECT id, partner_email FROM investors WHERE LOWER(partner_email) IN (${placeholders(args.emails.length)})`,
        )
        .all<{ id: string; partner_email: string }>(...args.emails);
      out.investors = rows ?? [];
    } catch {
      // table missing
    }

    try {
      const rows = await db
        .prepare(
          `SELECT id, email FROM people WHERE LOWER(email) IN (${placeholders(args.emails.length)})`,
        )
        .all<{ id: string; email: string }>(...args.emails);
      out.candidates = rows ?? [];
    } catch {
      // table missing
    }
  }

  return out;
}

async function matchGmail(item: MatchItem, acc: Map<string, PipelineMatch>): Promise<void> {
  const participants = extractEmails(item.metadata.participants);
  if (participants.length === 0) return;

  const domains = emailsToDomains(participants);
  const { deals, investors, candidates } = await queryMatches({
    domains,
    emails: participants,
    matchDealsByDomain: true,
    dealsConfidence: 0.8,
    investorsConfidence: 0.9,
    candidatesConfidence: 0.9,
  });

  for (const d of deals) addMatch(acc, 'deals', d.id, 'domain_match', 0.8);
  for (const i of investors) addMatch(acc, 'investors', i.id, 'email_match', 0.9);
  for (const c of candidates) addMatch(acc, 'people', c.id, 'email_match', 0.9);
}

async function matchGcal(item: MatchItem, acc: Map<string, PipelineMatch>): Promise<void> {
  const attendees = extractEmails(item.metadata.attendees);
  if (attendees.length === 0) return;

  const domains = emailsToDomains(attendees);
  const { deals, investors, candidates } = await queryMatches({
    domains,
    emails: attendees,
    matchDealsByDomain: true,
    dealsConfidence: 0.7,
    investorsConfidence: 0.85,
    candidatesConfidence: 0.85,
  });

  const dealRe = /intro|demo|sync|kickoff/i;
  const candRe = /interview|onsite|screen/i;
  const invRe = /diligence|partner meeting|term sheet/i;
  const titleHint = {
    deal: dealRe.test(item.title),
    candidate: candRe.test(item.title),
    investor: invRe.test(item.title),
  };

  for (const d of deals) {
    addMatch(acc, 'deals', d.id, 'domain_match', 0.7);
    if (titleHint.deal) boostMatch(acc, 'deals', d.id, 0.1);
  }
  for (const i of investors) {
    addMatch(acc, 'investors', i.id, 'email_match', 0.85);
    if (titleHint.investor) boostMatch(acc, 'investors', i.id, 0.1);
  }
  for (const c of candidates) {
    addMatch(acc, 'people', c.id, 'email_match', 0.85);
    if (titleHint.candidate) boostMatch(acc, 'people', c.id, 0.1);
  }
}

async function matchGdrive(item: MatchItem, acc: Map<string, PipelineMatch>): Promise<void> {
  const owners = extractEmails(item.metadata.owners);
  const domains = emailsToDomains(owners);

  if (owners.length > 0 || domains.length > 0) {
    const { deals, investors, candidates } = await queryMatches({
      domains,
      emails: owners,
      matchDealsByDomain: true,
      dealsConfidence: 0.6,
      investorsConfidence: 0.6,
      candidatesConfidence: 0.6,
    });
    for (const d of deals) addMatch(acc, 'deals', d.id, 'domain_match', 0.6);
    for (const i of investors) addMatch(acc, 'investors', i.id, 'email_match', 0.6);
    for (const c of candidates) addMatch(acc, 'people', c.id, 'email_match', 0.6);
  }

  // Title-name match against deals.name. We need a per-row regex test, so
  // fetching name+id once for the workspace's deals is unavoidable. Cap at
  // a sane limit to keep the query bounded; founders won't have thousands.
  if (item.title) {
    try {
      const db = getLibsqlDb();
      const rows = await db
        .prepare(`SELECT id, name FROM deals WHERE name IS NOT NULL AND length(name) > 1`)
        .all<{ id: string; name: string }>();
      for (const r of rows ?? []) {
        const re = new RegExp(`\\b${escapeRegex(r.name)}\\b`, 'i');
        if (re.test(item.title)) {
          addMatch(acc, 'deals', r.id, 'title_match', 0.7);
        }
      }
    } catch {
      // table missing
    }
  }
}

/**
 * Match a freshly-ingested item to pipeline rows.
 *
 * @param workspaceId  reserved for future per-workspace scoping (the custom
 *                     tables are currently un-namespaced; spec section 4.1
 *                     stores workspace_id on pipeline_links instead).
 * @param item         the source-mapped work item to match against pipelines.
 *
 * Returns an empty array for any source that isn't gmail/gcal/gdrive.
 * Multiple matches are allowed (a thread can match both a deal and an investor).
 */
export async function matchItemToPipelineRows(
  workspaceId: string,
  item: MatchItem,
): Promise<PipelineMatch[]> {
  void workspaceId; // currently un-namespaced custom tables; param reserved
  const acc = new Map<string, PipelineMatch>();

  switch (item.source) {
    case 'gmail':
      await matchGmail(item, acc);
      break;
    case 'gcal':
      await matchGcal(item, acc);
      break;
    case 'gdrive':
      await matchGdrive(item, acc);
      break;
    default:
      return [];
  }

  return Array.from(acc.values());
}
