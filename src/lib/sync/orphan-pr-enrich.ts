/**
 * Orphan-PR intent translation.
 */
import { z } from 'zod';
import { generateObject } from 'ai';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';

const PrIntentSchema = z.object({
  functional_summary: z.string().describe(
    'One short sentence in plain English describing what this PR functionally changes. ' +
      'Focus on the outcome (what changes for the user, the system, the data) rather than file names. ' +
      'Use language a Jira ticket would use: terms like "fix", "add", "refactor", "rename", "wire up", "remove", "migrate". ' +
      'Avoid markdown, file paths, code identifiers when an outcome word will do.',
  ),
});

const ORPHAN_BATCH_LIMIT = 100;
const PROMPT_DIFF_CAP_CHARS = 6000;

export interface OrphanPrEnrichResult {
  scanned: number;
  enriched: number;
  failed: number;
  errors: string[];
}

interface OrphanPrRow {
  id: string;
  pr_ref: string;
  title: string | null;
  body: string | null;
  diff_text: string | null;
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

async function loadOrphanPrsNeedingIntent(limit: number): Promise<OrphanPrRow[]> {
  const db = getLibsqlDb();
  return await db
    .prepare(
      `SELECT id, pr_ref, title, body, diff_text
       FROM issue_trails
       WHERE match_status = 'unmatched'
         AND kind = 'pr_opened'
         AND diff_text IS NOT NULL
         AND functional_summary IS NULL
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all<OrphanPrRow>(limit);
}

async function summarizeOnePr(row: OrphanPrRow): Promise<string | null> {
  const system = [
    'You are translating a GitHub pull request into one plain-English sentence describing what the change DOES.',
    'You will be given the title, the description (often empty/sparse), and a truncated patch.',
    'Read the patch to infer functional intent — what user-visible, architectural, or behavioral outcome the change has.',
    'Output a single sentence under 30 words. No file paths. No markdown. No "this PR" / "this change" preamble — start with the action verb.',
  ].join('\n');

  const diff = (row.diff_text ?? '').slice(0, PROMPT_DIFF_CAP_CHARS);
  const user = [
    `Title: ${row.title ?? '(empty)'}`,
    row.body?.trim() ? `Description:\n${row.body.trim()}` : 'Description: (empty)',
    '',
    'Patch (truncated):',
    diff,
  ].join('\n');

  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 200,
      system,
      schema: PrIntentSchema,
      prompt: user,
    });
    const summary = object.functional_summary?.trim();
    return summary && summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

async function persistIntent(trailId: string, intent: string): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `UPDATE issue_trails
       SET functional_summary = ?, functional_summary_generated_at = datetime('now')
       WHERE pr_ref = (SELECT pr_ref FROM issue_trails WHERE id = ?)
         AND match_status = 'unmatched'`,
    )
    .run(intent, trailId);
}

export async function enrichOrphanPrIntents(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<OrphanPrEnrichResult> {
  await ensureInit();
  const limit = opts.limit ?? ORPHAN_BATCH_LIMIT;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const rows = await loadOrphanPrsNeedingIntent(limit);
  const result: OrphanPrEnrichResult = { scanned: rows.length, enriched: 0, failed: 0, errors: [] };
  if (rows.length === 0) return result;

  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const summaries = await Promise.all(batch.map((r) => summarizeOnePr(r)));
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const summary = summaries[j];
      if (summary) {
        await persistIntent(row.id, summary);
        result.enriched++;
      } else {
        result.failed++;
        result.errors.push(`${row.pr_ref}: no summary returned`);
      }
    }
  }

  return result;
}
