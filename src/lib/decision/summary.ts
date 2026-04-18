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

export interface DecisionStructuredSummary {
  context: string;
  decision: string;
  rationale: string;
  outcome: string;
  status_note: string;
  traceability: Array<{
    item_id: string;
    source: string;
    role: string;
    time: string;
    title: string;
    contribution: string;
  }>;
}

function buildPrompt(d: DecisionSummary, items: DecisionItem[]): { system: string; user: string } {
  const system = `You are producing a structured DECISION RECORD.

Input is a decision and all the source items that led up to it or flowed from it.
Each source item has a "relation" telling you how it fits: origin (seed), discussion, self (the decision itself), specification, implementation, review, integration, follow_up.

Produce a single JSON object with these exact fields (no prose outside JSON, no markdown fences):

{
  "context":    "2-3 sentences — what problem or situation motivated this decision. Cite the origin seed or discussion if present.",
  "decision":   "1-2 sentences — what was actually decided, in concrete terms. Refer to the decision's title but expand it.",
  "rationale":  "2-3 sentences — WHY this choice. Pull reasoning from the discussion items. If rationale is not explicit in sources, say so plainly.",
  "outcome":    "2-3 sentences — what got built / merged / shipped as a result. If no implementation yet, say 'No implementation yet — pending specification/PR.'",
  "status_note": "1 sentence — current state (active / implemented / superseded / reversed), and why.",
  "traceability": [
    { "item_id": "<id>", "source": "<jira|slack|notion|github|meeting>", "role": "<origin|discussion|self|specification|implementation|review|integration|follow_up>", "time": "YYYY-MM-DD", "title": "<truncated title>", "contribution": "<1 sentence — what THIS item contributed to the trace>" }
  ]
}

The "traceability" array must include every input item in chronological order. Be specific in "contribution" — don't say "discussed the decision"; say "raised the concern about backfill safety under concurrent writes" (for example).`;

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
    lines.push(`[${it.relation}] (${when}) ${it.source}/${it.item_type} id=${it.id}`);
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
      typeof parsed.rationale !== 'string' ||
      typeof parsed.outcome !== 'string'
    ) return null;
    return {
      context: parsed.context,
      decision: parsed.decision,
      rationale: parsed.rationale,
      outcome: parsed.outcome,
      status_note: parsed.status_note ?? '',
      traceability: Array.isArray(parsed.traceability) ? parsed.traceability.map((t: any) => ({
        item_id: String(t.item_id ?? ''),
        source: String(t.source ?? ''),
        role: String(t.role ?? ''),
        time: String(t.time ?? ''),
        title: String(t.title ?? ''),
        contribution: String(t.contribution ?? ''),
      })) : [],
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
