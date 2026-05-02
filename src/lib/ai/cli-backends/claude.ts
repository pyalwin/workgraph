import type { CliBackend, CliBackendOptions, CliEvent } from './types';
import { isOnPath, spawnCliLines, tryParseJson } from './utils';

/**
 * Claude Code adapter. Uses `claude -p <prompt> --output-format stream-json
 * --include-partial-messages` to get incremental events. The CLI runs its
 * own agentic loop with built-in tools (Bash, Read, Edit, Grep) — handy
 * because it can directly inspect db.sqlite3, project files, etc.
 *
 * stream-json event shapes (relevant subset):
 *   { type: "system", subtype: "init", session_id, model, ... }
 *   { type: "stream_event", event: { type: "content_block_delta",
 *       delta: { type: "text_delta", text: "..." } } }
 *   { type: "assistant", message: { content: [{ type: "text", text }] } }
 *   { type: "user", tool_use_result: { stdout, stderr } }
 *   { type: "result", subtype: "success", session_id, total_cost_usd, result }
 */
async function* streamClaude(opts: CliBackendOptions): AsyncIterable<CliEvent> {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.disableTools) {
    // --bare strips hooks/skills/CLAUDE.md auto-loading and limits the
    // surface to pure text generation. Combined with --disallowed-tools,
    // the run is effectively a sandboxed one-shot prompt → text call.
    args.push(
      '--bare',
      '--disallowed-tools',
      'Bash,Edit,Read,Grep,Glob,Write,WebFetch,Task,NotebookEdit',
    );
  }

  const gen = spawnCliLines('claude', args, {
    cwd: opts.cwd,
    signal: opts.signal,
  });

  // Track whether we streamed any deltas. If yes, suppress the `assistant`
  // and `result` final text (they'd duplicate everything we already sent).
  let streamedAnyDelta = false;

  for await (const line of gen) {
    const evt = tryParseJson(line) as Record<string, unknown> | null;
    if (!evt) continue;

    if (evt.type === 'stream_event') {
      const inner = (evt.event as Record<string, unknown> | undefined) ?? {};
      const delta = inner.delta as { type?: string; text?: string } | undefined;
      if (inner.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        streamedAnyDelta = true;
        yield { type: 'text-delta', text: delta.text };
      }
      continue;
    }

    if (evt.type === 'assistant' && !('event' in evt) && !streamedAnyDelta) {
      // Fallback: full assistant message arrived without partial deltas.
      const msg = evt.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = msg?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text) yield { type: 'text-delta', text };
      continue;
    }

    if (evt.type === 'result') {
      if (!streamedAnyDelta && typeof evt.result === 'string' && evt.result.trim()) {
        yield { type: 'text-delta', text: evt.result };
      }
      const usage = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      yield {
        type: 'finish',
        reason: typeof evt.subtype === 'string' ? evt.subtype : 'stop',
        usage: { input: usage?.input_tokens, output: usage?.output_tokens },
      };
      return;
    }
  }

  yield { type: 'finish', reason: 'stop' };
}

export const claudeBackend: CliBackend = {
  id: 'claude',
  label: 'Claude Code',
  isAvailable: () => isOnPath('claude'),
  stream: streamClaude,
};
