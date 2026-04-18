/**
 * Workstream summary generation via Sonnet.
 *
 * Input: a workstream's items ordered chronologically with trace_role.
 * Output: a 3-5 sentence narrative + structured timeline_events JSON.
 *
 * Sonnet reads the evolution and writes the decision trace. Stored on
 * workstreams.narrative and workstreams.timeline_events (JSON).
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { listWorkstreams } from './assemble';

interface WSItem {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  trace_role: string | null;
  role_in_workstream: string | null;
  event_at: string | null;
  trace_event_at: string | null;
  created_at: string;
  is_seed: number;
  is_terminal: number;
  summary: string | null;
  body: string | null;
}

export interface TimelineEvent {
  item_id: string;
  source: string;
  role: string | null;
  time: string;
  title: string;
  one_liner: string;
}

export interface WorkstreamSummaryPayload {
  narrative: string;
  timeline_events: TimelineEvent[];
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

function loadWSItems(wsId: string): WSItem[] {
  return getDb().prepare(`
    SELECT
      wi.id, wi.source, wi.source_id, wi.item_type, wi.title,
      wi.trace_role, wi.trace_event_at, wi.created_at, wi.summary, wi.body,
      wsi.is_seed, wsi.is_terminal, wsi.role_in_workstream, wsi.event_at
    FROM workstream_items wsi
    JOIN work_items wi ON wi.id = wsi.item_id
    WHERE wsi.workstream_id = ?
    ORDER BY COALESCE(wsi.event_at, wi.created_at) ASC
  `).all(wsId) as WSItem[];
}

function buildPrompt(items: WSItem[]): { system: string; user: string } {
  const system = `You are summarizing a WORKSTREAM — the trace of how an idea evolved into shipped code.

A workstream is made of items across sources (Notion / JIRA / Slack / GitHub / meetings), each tagged with a role in the lifecycle:
seed → discussion → decision → specification → implementation → review → integration → follow_up

Produce exactly two outputs as a single JSON object:

1. "narrative": 3-5 sentence prose paragraph describing the arc. Cover:
   - Where/how it started (the seed)
   - Key decision points or debates
   - What got built, and how it shipped
   - Be specific: mention titles, dates, outcomes. Avoid generic summaries.

2. "timeline_events": An array, one entry per item in chronological order:
   { "item_id": "...", "source": "...", "role": "...", "time": "YYYY-MM-DD", "title": "...", "one_liner": "..." }
   Where one_liner is a 1-sentence description of what THIS item contributed to the trace.

Return ONLY valid JSON, no markdown fences, no commentary.`;

  const lines: string[] = ['Items in this workstream (chronological):', ''];
  for (const it of items) {
    const roleMark = it.is_seed ? '★SEED ' : it.is_terminal ? '✓INTEG ' : '       ';
    const role = it.role_in_workstream ?? it.trace_role ?? '—';
    const when = (it.event_at ?? it.created_at).slice(0, 10);
    const summary = it.summary ?? (it.body ? it.body.slice(0, 180) : '');
    lines.push(`${roleMark}[${when}] (${it.source}/${it.item_type}) role=${role} id=${it.id}`);
    lines.push(`        title: ${it.title.slice(0, 140)}`);
    if (summary) lines.push(`        note:  ${summary.slice(0, 220)}`);
  }
  return { system, user: lines.join('\n') };
}

async function callSonnet(prompt: { system: string; user: string }): Promise<WorkstreamSummaryPayload | null> {
  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.narrative !== 'string' || !Array.isArray(parsed.timeline_events)) return null;
    return {
      narrative: parsed.narrative,
      timeline_events: parsed.timeline_events.map((e: any) => ({
        item_id: String(e.item_id ?? ''),
        source: String(e.source ?? ''),
        role: e.role ?? null,
        time: String(e.time ?? ''),
        title: String(e.title ?? ''),
        one_liner: String(e.one_liner ?? ''),
      })),
    };
  } catch (err: any) {
    console.error(`  Sonnet error: ${err.message}`);
    return null;
  }
}

export async function summarizeWorkstream(wsId: string): Promise<boolean> {
  const items = loadWSItems(wsId);
  if (items.length < 1) return false;

  const prompt = buildPrompt(items);
  const payload = await callSonnet(prompt);
  if (!payload) return false;

  getDb().prepare(`
    UPDATE workstreams
    SET narrative = ?, timeline_events = ?, generated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(payload.narrative, JSON.stringify(payload.timeline_events), wsId);

  return true;
}

export async function summarizeAllWorkstreams(opts: { force?: boolean; minItems?: number; concurrency?: number } = {}): Promise<{ generated: number; skipped: number; failed: number }> {
  const force = opts.force ?? false;
  const minItems = opts.minItems ?? 2;
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  const all = listWorkstreams();
  const pending = all.filter(ws => {
    if (ws.item_count < minItems) return false;
    if (!force && ws.narrative && ws.generated_at) return false;
    return true;
  });

  console.log(`  ${pending.length} workstreams to summarize (of ${all.length} total; min_items=${minItems})`);

  const result = { generated: 0, skipped: all.length - pending.length, failed: 0 };

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const outcomes = await Promise.all(
      batch.map(async (ws, j) => {
        const idx = i + j + 1;
        process.stdout.write(`  [${idx}/${pending.length}] ws=${ws.id.slice(0, 8)} items=${ws.item_count}...`);
        const ok = await summarizeWorkstream(ws.id);
        console.log(ok ? ' OK' : ' FAIL');
        return ok;
      }),
    );
    for (const ok of outcomes) ok ? result.generated++ : result.failed++;
  }

  return result;
}
