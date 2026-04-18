/**
 * Decision-record structured summary generation via Sonnet.
 *
 * Unlike workstream narratives (freeform paragraph), a decision record
 * returns explicit sections: Context, Decision, Rationale, Outcome,
 * Traceability. Each with strict size caps so the output is uniform.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { getDecisionItems, listDecisions, type DecisionItem, type DecisionSummary } from './extract';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface TraceEntry {
  item_id: string;
  source: string;
  role: string;
  time: string;
  title: string;
  contribution: string;
}

export interface DecisionStructuredSummary {
  context: string;
  decision: string;
  rationale: string;
  what_was_asked: string;
  what_was_shipped: string;
  gap_analysis: string;
  status_note: string;
  discussion_trace: TraceEntry[];
  implementation_trace: TraceEntry[];
}

function buildPrompt(d: DecisionSummary, items: DecisionItem[]): { system: string; user: string } {
  const system = `You are producing a structured DECISION RECORD that explicitly contrasts WHAT WAS ASKED / DISCUSSED (from JIRA / Notion / Slack / meetings) against WHAT WAS SHIPPED (from GitHub PRs and commits).

Input: a decision item + all source items that led up to it or flowed from it.

Source-item phases:
  DISCUSSION PHASE  — jira, notion, slack, meeting items; origin/discussion/self/specification roles. These define the ask.
  IMPLEMENTATION PHASE — github items; implementation/review/integration roles. These are the output.
  FOLLOW-UP         — items that appeared after integration (bug reports, retros).

Return a single JSON object, no markdown fences, no prose outside JSON:

{
  "context":          "2-3 sentences — what problem or situation motivated this decision. Cite the origin seed if present.",
  "decision":         "1-2 sentences — what was actually decided, concrete terms.",
  "rationale":        "2-3 sentences — WHY this choice. Pull reasoning from discussion items. If rationale is not explicit in sources, say so plainly.",
  "what_was_asked":   "2-3 sentences summarising the ASK as defined in JIRA / Notion / Slack / meetings. Be specific about scope, acceptance criteria, or stakeholder intent.",
  "what_was_shipped": "2-3 sentences summarising WHAT WAS ACTUALLY BUILT per GitHub PRs and commits. Mention file areas, approach, or notable trade-offs. If no implementation yet, state 'No implementation yet — pending PR.'",
  "gap_analysis":     "1-2 sentences comparing ask vs. shipped. Did implementation match? Any scope cut, deviation, or open work? If fully aligned, say so briefly.",
  "status_note":      "1 sentence — current state (active / implemented / superseded / reversed) with a concrete reason.",
  "discussion_trace": [
    { "item_id": "<id>", "source": "<jira|slack|notion|meeting>", "role": "<origin|discussion|self|specification|follow_up>", "time": "YYYY-MM-DD", "title": "<truncated>", "contribution": "<what THIS item added to the ask>" }
  ],
  "implementation_trace": [
    { "item_id": "<id>", "source": "github", "role": "<implementation|review|integration>", "time": "YYYY-MM-DD", "title": "<truncated>", "contribution": "<what THIS PR/commit shipped>" }
  ]
}

Rules:
- Put jira/notion/slack/meeting items in discussion_trace (chronological).
- Put github items in implementation_trace (chronological).
- If there are no github items, leave implementation_trace as [] — and say so in what_was_shipped.
- Contributions must be specific ("raised backfill safety concern under concurrent writes"), never generic ("discussed the decision").`;

  const lines: string[] = [
    `Decision: "${d.title}"`,
    `Decided at: ${d.decided_at}`,
    `Decided by: ${d.decided_by ?? '(unknown)'}`,
    `Current status: ${d.status}`,
    '',
    'Source items (chronological, grouped by relation):',
    '',
  ];
  for (const it of items) {
    const when = (it.event_at ?? it.created_at).slice(0, 10);
    const summary = it.summary ?? (it.body ? it.body.slice(0, 200) : '');
    const phase = it.source === 'github' ? 'IMPL' : 'DISC';
    lines.push(`[${phase}] [${it.relation}] (${when}) ${it.source}/${it.item_type} id=${it.id}`);
    lines.push(`  title: ${it.title.slice(0, 140)}`);
    if (summary) lines.push(`  note:  ${summary.slice(0, 240)}`);
  }

  return { system, user: lines.join('\n') };
}

async function callSonnet(prompt: { system: string; user: string }): Promise<DecisionStructuredSummary | null> {
  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      typeof parsed.context !== 'string' ||
      typeof parsed.decision !== 'string' ||
      typeof parsed.rationale !== 'string'
    ) return null;
    const toTrace = (arr: any): TraceEntry[] =>
      Array.isArray(arr) ? arr.map((t: any) => ({
        item_id: String(t.item_id ?? ''),
        source: String(t.source ?? ''),
        role: String(t.role ?? ''),
        time: String(t.time ?? ''),
        title: String(t.title ?? ''),
        contribution: String(t.contribution ?? ''),
      })) : [];
    return {
      context: parsed.context,
      decision: parsed.decision,
      rationale: parsed.rationale,
      what_was_asked: parsed.what_was_asked ?? '',
      what_was_shipped: parsed.what_was_shipped ?? '',
      gap_analysis: parsed.gap_analysis ?? '',
      status_note: parsed.status_note ?? '',
      discussion_trace: toTrace(parsed.discussion_trace),
      implementation_trace: toTrace(parsed.implementation_trace),
    };
  } catch (err: any) {
    console.error(`  Sonnet error (decision): ${err.message}`);
    return null;
  }
}

export async function summarizeDecision(decisionId: string): Promise<boolean> {
  const d = listDecisions().find(x => x.id === decisionId);
  if (!d) return false;
  const items = getDecisionItems(decisionId);
  const prompt = buildPrompt(d, items);
  const structured = await callSonnet(prompt);
  if (!structured) return false;

  getDb().prepare(`
    UPDATE decisions
    SET summary = ?, generated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(structured), decisionId);
  return true;
}

export async function summarizeAllDecisions(opts: { force?: boolean; concurrency?: number } = {}): Promise<{ generated: number; skipped: number; failed: number }> {
  const force = opts.force ?? false;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const all = listDecisions();
  const pending = all.filter(d => force || !d.summary || !d.generated_at);

  console.log(`  ${pending.length} decisions to summarize (of ${all.length} total)`);
  const result = { generated: 0, skipped: all.length - pending.length, failed: 0 };

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const outcomes = await Promise.all(
      batch.map(async (d, j) => {
        const idx = i + j + 1;
        process.stdout.write(`  [${idx}/${pending.length}] "${d.title.slice(0, 50)}..."`);
        const ok = await summarizeDecision(d.id);
        console.log(ok ? ' OK' : ' FAIL');
        return ok;
      }),
    );
    for (const ok of outcomes) ok ? result.generated++ : result.failed++;
  }
  return result;
}
