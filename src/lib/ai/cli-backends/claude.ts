import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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

  // Optional MCP bridge — chat path passes a server config so Claude Code
  // can call Workgraph data tools (countItems, listItems, searchKnowledge,
  // etc.) hosted at /api/mcp. Written to a temp file because --mcp-config
  // takes a path. Cleaned up after the stream ends.
  let mcpConfigPath: string | null = null;
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    try {
      const dir = await mkdtemp(join(tmpdir(), 'workgraph-mcp-'));
      mcpConfigPath = join(dir, 'mcp.json');
      await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: opts.mcpServers }), 'utf8');
      args.push('--mcp-config', mcpConfigPath);
    } catch (err) {
      console.warn('[claude-cli] failed to write mcp-config; continuing without it:', err instanceof Error ? err.message : String(err));
      mcpConfigPath = null;
    }
  }

  // Visibility: log when the CLI subprocess is invoked. Lets users confirm
  // (via the `web` stream of `npm run dev:all`) that "Claude Code" task
  // routing is actually firing — there's no agent-log path for these calls
  // since they run inside the web server, not the local agent.
  const promptPreview = (opts.prompt || '').replace(/\s+/g, ' ').slice(0, 90);
  console.log(
    `[claude-cli] spawn model=${opts.model ?? 'default'} bare=${opts.disableTools ? 'yes' : 'no'} prompt="${promptPreview}${promptPreview.length === 90 ? '…' : ''}"`,
  );
  const startedAt = Date.now();

  const gen = spawnCliLines('claude', args, {
    cwd: opts.cwd,
    signal: opts.signal,
  });

  // Cleanup the temp MCP config when the iterator finishes (or aborts).
  // Wrapped in try/finally on the generator below.
  const cleanup = async () => {
    if (mcpConfigPath) {
      try { await unlink(mcpConfigPath); } catch { /* best-effort */ }
      mcpConfigPath = null;
    }
  };

  // Track whether we streamed any deltas. If yes, suppress the `assistant`
  // and `result` final text (they'd duplicate everything we already sent).
  let streamedAnyDelta = false;

  try {
  for await (const line of gen) {
    const evt = tryParseJson(line) as Record<string, unknown> | null;
    if (!evt) continue;

    // MCP-bridge visibility. Surface MCP server connection results, tool
    // calls the model issued, and tool results — failures hide silently
    // otherwise and the model just answers "I don't have access" with no
    // breadcrumb for the operator.
    if (evt.type === 'system' && evt.subtype === 'init') {
      const mcpServers = (evt.mcp_servers as Array<{ name?: string; status?: string }> | undefined) ?? [];
      if (mcpServers.length > 0) {
        for (const s of mcpServers) {
          console.log(`[claude-cli mcp] ${s.name ?? '?'} → ${s.status ?? '?'}`);
        }
      }
      continue;
    }

    // Tool call attempts — log name + a preview of inputs.
    if (evt.type === 'assistant') {
      const msg = evt.message as { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined;
      const toolBlocks = (msg?.content ?? []).filter((c) => c.type === 'tool_use');
      for (const tb of toolBlocks) {
        const inputPreview = JSON.stringify(tb.input ?? {}).slice(0, 120);
        console.log(`[claude-cli tool-use] ${tb.name ?? '?'} input=${inputPreview}`);
      }
    }

    // Tool results — log whether each call returned or errored.
    if (evt.type === 'user') {
      const msg = evt.message as { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> } | undefined;
      const resultBlocks = (msg?.content ?? []).filter((c) => c.type === 'tool_result');
      for (const rb of resultBlocks) {
        if (rb.is_error) {
          const errPreview = typeof rb.content === 'string'
            ? rb.content.slice(0, 240)
            : JSON.stringify(rb.content ?? '').slice(0, 240);
          console.warn(`[claude-cli tool-error] id=${rb.tool_use_id ?? '?'} ${errPreview}`);
        } else {
          const outPreview = typeof rb.content === 'string'
            ? rb.content.slice(0, 120)
            : JSON.stringify(rb.content ?? '').slice(0, 120);
          console.log(`[claude-cli tool-result] id=${rb.tool_use_id ?? '?'} ok=true preview=${outPreview}`);
        }
      }
    }

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
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[claude-cli] finish ${elapsed}s in=${usage?.input_tokens ?? '?'} out=${usage?.output_tokens ?? '?'} reason=${typeof evt.subtype === 'string' ? evt.subtype : 'stop'}`,
      );
      yield {
        type: 'finish',
        reason: typeof evt.subtype === 'string' ? evt.subtype : 'stop',
        usage: { input: usage?.input_tokens, output: usage?.output_tokens },
      };
      await cleanup();
      return;
    }
  }
  } finally {
    await cleanup();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[claude-cli] finish ${elapsed}s reason=stop (no result event)`);
  yield { type: 'finish', reason: 'stop' };
}

export const claudeBackend: CliBackend = {
  id: 'claude',
  label: 'Claude Code',
  isAvailable: () => isOnPath('claude'),
  stream: streamClaude,
};
