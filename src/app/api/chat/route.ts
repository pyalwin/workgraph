import { NextRequest } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { getModel } from '@/lib/ai';
import { chatTools } from '@/lib/ai/chat-tools';
import { getOpenUIPrompt } from '@/lib/ai/openui-prompt';
import { getCliBackend, type BackendId } from '@/lib/ai/cli-backends';
import {
  createChatThread,
  deriveThreadTitle,
  getChatThread,
  renameChatThread,
  replaceChatMessages,
} from '@/lib/chat-threads';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are an assistant embedded in Workgraph — a system that ingests work artifacts (Jira tickets, GitHub PRs, Notion pages, meeting notes, Slack threads) and surfaces project health.

DATA MODEL
- work_items: every Jira ticket, Notion page, meeting, Slack message, repository, release, manual note, etc.
  - source ∈ jira | github | slack | granola | notion | manual
  - item_type varies by source (task | bug | story | repository | release | note | meeting | ...)
  - status: free-form (open, in_progress, done, closed, etc.)
- issue_trails: GitHub PR events. PRs are NOT in work_items — they live here as one row per event (pr_opened, pr_review, pr_merged, pr_closed). Latest row per pr_ref = current state.
- projects: high-level groupings keyed by short codes (e.g. ALPHA, BETA). Use findProject to resolve names.
- decisions: extracted from meetings/PR reviews.

TOOL PICKING — pick the most specific tool first:
1. "How many X?" / counts / status breakdowns → countItems, countPRs, groupItems.
2. PR questions ("how many open PRs", "list merged PRs") → countPRs / listPRs (NOT searchKnowledge).
3. Project name mentioned ("ALPHA", "BETA") → findProject → getProject.
4. "What projects exist" / "what's at risk" → listProjects.
5. Decisions ("what did we decide", "rationale") → listDecisions.
6. "Show me items where..." → listItems with filters.
7. Content / topic questions ("what was discussed about onboarding", "find docs mentioning X") → searchKnowledge.
8. "What blocks / depends on / duplicates this ticket" → getRelatedItems.
9. "Show me ticket ALPHA-55 / item by id" → getById.
10. Ad-hoc joins, custom aggregations, time-series, anything else → describeSchema first, then runQuery.
11. "Save this as a note" → createNote.

DISCOVERY
- If you're unsure what data exists, call describeSchema() with no args. It returns every table, its columns, and row counts. Then call describeSchema(table) for the table you need before writing a runQuery.

RULES
- NEVER use searchKnowledge for counts or status questions — it returns content chunks, not aggregates.
- Ground every answer in tool output. Do not invent project keys, ticket IDs, statuses, or counts.
- If a tool returns 0 results, try a broader filter or a different tool before giving up.
- Cite items by source_id (e.g. ALPHA-55, owner/repo#123) and title.

RESPONSE LENGTH
- Default: terse — bullets and short paragraphs.
- When the user asks for a "report", "summary", "deep dive", "breakdown", "review", "weekly update", or any analysis question, produce a full structured document: title, overview, sections with headers, supporting tables/charts, citations, conclusions. Use OpenUI Lang for tables and charts where useful.
- Chain multiple tool calls when needed — you have up to 25 steps. Use them: pull projects, fetch detail per project, query cross-tab metrics with runQuery, then synthesize.
- For broad "what's going on" questions, do not stop at one tool call. Pull project list → for each project fetch detail → identify themes → write the synthesis.

PRESENTATION
- For richer output you may include OpenUI Lang fenced blocks (\`\`\`openui-lang) AFTER tools return — e.g. a BarChart for groupItems output, a Table for runQuery rows, a Card for a project summary. Plain markdown is still fine; only use OpenUI Lang when it adds clarity over text.

ALMANAC TOOLS
- For chronological "how did X evolve" questions, reach for \`listUnitEvolution\`. For fuzzy "what was the original purpose / how was it discussed" questions, first try \`searchKnowledge\` (it now indexes Almanac sections — citations will point to specific section anchors). For drift questions ("what shipped without a ticket", "what was promised but not built"), use \`getDriftForUnit\` or scan \`code_events\` via \`runQuery\`.

${getOpenUIPrompt()}`;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    messages: UIMessage[];
    id?: string;
    backend?: BackendId;
    model?: string;
  };
  const messages = body.messages;
  const backendId: BackendId = body.backend ?? 'sdk';

  // Resolve thread: reuse existing, or auto-create on first turn. When the
  // client provides an id that doesn't exist yet, create the row WITH that
  // id so client URLs (?thread=<uuid>) stay valid.
  let threadId = body.id;
  let isNewThread = false;
  if (threadId) {
    if (!(await getChatThread(threadId))) {
      await createChatThread(undefined, threadId);
      isNewThread = true;
    }
  } else {
    threadId = (await createChatThread()).id;
    isNewThread = true;
  }

  // ───── CLI backend path (Claude Code / Codex / Gemini) ─────
  if (backendId !== 'sdk') {
    const backend = getCliBackend(backendId);
    if (!backend) {
      return new Response(JSON.stringify({ error: `unknown backend: ${backendId}` }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!(await backend.isAvailable())) {
      return new Response(
        JSON.stringify({ error: `${backend.label} CLI not found on PATH.` }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Collapse the UI history into a single prompt the CLI can consume.
    const transcript = messages
      .map((m) => {
        const text = m.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('');
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
      })
      .join('\n\n');

    const stream = createUIMessageStream<UIMessage>({
      originalMessages: messages,
      execute: async ({ writer }) => {
        const textId = crypto.randomUUID();
        let textStarted = false;
        const ensureTextStarted = () => {
          if (textStarted) return;
          writer.write({ type: 'text-start', id: textId });
          textStarted = true;
        };
        writer.write({ type: 'start' });
        writer.write({ type: 'start-step' });
        try {
          for await (const evt of backend.stream({
            prompt: transcript,
            systemPrompt: SYSTEM_PROMPT,
            cwd: process.cwd(),
            model: body.model,
            signal: req.signal,
          })) {
            if (evt.type === 'text-delta') {
              ensureTextStarted();
              writer.write({ type: 'text-delta', id: textId, delta: evt.text });
            } else if (evt.type === 'error') {
              ensureTextStarted();
              writer.write({ type: 'text-delta', id: textId, delta: `\n\n_Error: ${evt.message}_` });
              break;
            } else if (evt.type === 'finish') {
              break;
            }
          }
        } catch (err) {
          ensureTextStarted();
          writer.write({
            type: 'text-delta',
            id: textId,
            delta: `\n\n_Backend error: ${(err as Error).message}_`,
          });
        }
        if (textStarted) writer.write({ type: 'text-end', id: textId });
        writer.write({ type: 'finish-step' });
        writer.write({ type: 'finish' });
      },
      onFinish: async ({ messages: finalMessages }) => {
        try {
          await replaceChatMessages(threadId!, finalMessages);
          if (isNewThread) {
            const title = deriveThreadTitle(finalMessages);
            if (title) await renameChatThread(threadId!, title);
          }
        } catch (err) {
          console.error('[chat] persist failed:', (err as Error).message);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  // ───── Default Vercel AI SDK path ─────
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: getModel('chat'),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: chatTools,
    stopWhen: stepCountIs(25),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ messages: finalMessages }) => {
      try {
        await replaceChatMessages(threadId!, finalMessages);
        if (isNewThread) {
          const title = deriveThreadTitle(finalMessages);
          if (title) await renameChatThread(threadId!, title);
        }
      } catch (err) {
        console.error('[chat] persist failed:', (err as Error).message);
      }
    },
  });
}
