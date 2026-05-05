/**
 * Lightweight CLI spawner for the local agent.
 *
 * Mirrors the logic in src/lib/ai/cli-backends/{codex,claude,gemini}.ts but
 * has ZERO runtime dependencies — only node: built-ins.  We cannot import from
 * the main src/ tree because packages/agent is a standalone npm package.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CliOptions {
  /** Which CLI binary to spawn. */
  cli: "codex" | "claude" | "gemini";
  /** User prompt (the task text). */
  prompt: string;
  /** Optional system instructions prepended to the prompt (all CLIs accept it inline). */
  systemPrompt?: string;
  /** Override the model the CLI uses. */
  model?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Abort signal — sends SIGTERM to the child when triggered. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the argv array and resolve the effective prompt string for each CLI.
 * Translated directly from the server-side adapters; no third-party deps.
 */
function buildArgs(opts: CliOptions): { binary: string; args: string[] } {
  const effectivePrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  switch (opts.cli) {
    case "codex": {
      // codex exec --json [--sandbox read-only] [-c model="…"] <prompt>
      const args: string[] = ["exec", "--json", "--sandbox", "read-only"];
      if (opts.model) args.push("-c", `model="${opts.model}"`);
      args.push(effectivePrompt);
      return { binary: "codex", args };
    }

    case "claude": {
      // claude -p <prompt> --output-format stream-json --include-partial-messages
      //        --verbose --dangerously-skip-permissions [--model …]
      //        --bare --disallowed-tools …
      const args: string[] = [
        "-p",
        effectivePrompt,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--dangerously-skip-permissions",
        "--bare",
        "--disallowed-tools",
        "Bash,Edit,Read,Grep,Glob,Write,WebFetch,Task,NotebookEdit",
      ];
      if (opts.model) args.push("--model", opts.model);
      return { binary: "claude", args };
    }

    case "gemini": {
      // gemini -p <prompt> -o stream-json --approval-mode plan [-m …]
      const args: string[] = [
        "-p",
        effectivePrompt,
        "-o",
        "stream-json",
        "--approval-mode",
        "plan",
      ];
      if (opts.model) args.push("-m", opts.model);
      return { binary: "gemini", args };
    }
  }
}

/** Best-effort JSON parse — returns null on any failure. */
function tryParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// streamCli — yields raw stdout lines
// ---------------------------------------------------------------------------

/**
 * Spawn the CLI and yield every non-empty stdout line.
 * Stderr is forwarded to process.stderr for visibility; stdout lines are
 * yielded raw so callers can apply their own parsing.
 */
export async function* streamCli(opts: CliOptions): AsyncIterable<string> {
  const { binary, args } = buildArgs(opts);
  const tag = `[cli ${binary}]`;
  const startedAt = Date.now();
  // Argv is huge for narrate prompts; show the binary + flags only.
  const printableArgs = args
    .map((a) => (a.length > 60 ? `<${a.length}c prompt>` : a))
    .join(" ");
  console.log(`${tag} spawn · cwd=${opts.cwd ?? '(default)'} · ${binary} ${printableArgs}`);

  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward stderr for debugging without polluting the JSONL stream.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`${tag} stderr · ${chunk.toString()}`);
  });

  const onAbort = (): void => { child.kill("SIGTERM"); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // Heartbeat: print every 30s so the user can tell the CLI is still
  // working on long unit/summary jobs (not silently hung).
  let lineCount = 0;
  let lastByteAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
    const sinceLastS = ((Date.now() - lastByteAt) / 1000).toFixed(0);
    console.log(`${tag} … alive · ${elapsedS}s elapsed · ${lineCount} lines · ${sinceLastS}s since last output`);
  }, 30_000);
  heartbeat.unref?.();

  try {
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) {
        lineCount++;
        lastByteAt = Date.now();
        yield trimmed;
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    clearInterval(heartbeat);
  }

  // Wait for the process to fully exit (ignore the code — callers handle
  // partial output gracefully by skipping non-JSON lines).
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("close", () => resolve());
  });

  const totalMs = Date.now() - startedAt;
  console.log(
    `${tag} done · ${(totalMs / 1000).toFixed(1)}s · ${lineCount} stdout lines · exit=${child.exitCode ?? '?'}`,
  );
}

// ---------------------------------------------------------------------------
// runCliJson — run to completion, return accumulated text
// ---------------------------------------------------------------------------

/**
 * Pretty-print every event the CLI emits so the operator can see each
 * tool call, turn boundary, and reasoning step in the agent terminal.
 *
 * Suppresses high-volume text-delta events (would print every keystroke
 * Codex/Claude/Gemini produces), but logs:
 *   - turn / thread lifecycle
 *   - every item.completed with item.type + a short summary
 *   - every function/tool call with name + args preview
 *   - every command execution + exit status
 *   - errors / warnings
 *
 * Prefix is `[cli <binary>] ›` so it visually nests under streamCli logs.
 */
function logCliEvent(cli: string, evt: Record<string, unknown>): void {
  const tag = `[cli ${cli}] ›`;
  const t = (evt.type as string | undefined) ?? '?';

  // Skip the high-frequency delta events
  if (
    t === 'agent_message_delta' ||
    t === 'item.delta' ||
    t === 'reasoning_delta' ||
    t === 'output_text.delta' ||
    t === 'response.output_text.delta' ||
    t === 'stream_event' || // Claude's per-keystroke delta envelope
    t === 'delta' ||
    // Skip item.started — it's always followed shortly by item.completed
    // with the same data, so logging both doubles the noise.
    t === 'item.started'
  ) {
    return;
  }

  // Codex v0.128+ wraps real action in item.completed { item: {...} }
  if (t === 'item.completed' && typeof evt.item === 'object' && evt.item !== null) {
    const item = evt.item as Record<string, unknown>;
    const itemType = (item.type as string | undefined) ?? '?';
    const { icon, label } = renderCodexItem(item, itemType);
    console.log(`${tag} ${icon} ${label}`);
    return;
  }

  // Codex turn / thread lifecycle
  if (t === 'turn.started') {
    console.log(`${tag} turn.started`);
    return;
  }
  if (t === 'turn.completed') {
    const usage = (evt.usage as Record<string, unknown> | undefined);
    const u = usage
      ? `in=${usage.input_tokens ?? '?'} cached=${usage.cached_input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} reasoning=${usage.reasoning_output_tokens ?? '?'}`
      : '';
    console.log(`${tag} turn.completed · ${u}`);
    return;
  }
  if (t === 'thread.started' || t === 'thread.created') {
    console.log(`${tag} ${t} · ${(evt.thread_id as string | undefined) ?? ''}`);
    return;
  }
  if (t === 'error' || t === 'warning') {
    console.error(`${tag} ${t} · ${JSON.stringify(evt).slice(0, 300)}`);
    return;
  }

  // Claude / Gemini common shapes
  if (t === 'message_start' || t === 'message_stop' || t === 'message_delta') {
    console.log(`${tag} ${t}`);
    return;
  }
  if (t === 'content_block_start') {
    const cb = (evt.content_block ?? {}) as Record<string, unknown>;
    console.log(`${tag} content_block_start · type=${cb.type ?? '?'} name=${cb.name ?? ''}`);
    return;
  }
  if (t === 'content_block_stop') {
    console.log(`${tag} content_block_stop · index=${evt.index ?? '?'}`);
    return;
  }

  // Anything else — print the type + a tiny summary so we can see new shapes
  console.log(`${tag} ${t} · ${JSON.stringify(evt).slice(0, 200)}`);
}

/**
 * Render Codex item.completed payloads as { icon, label } so the agent
 * terminal scans like a structured trace instead of a JSON dump:
 *
 *   📖  read src/lib/foo.ts (lines 1–380)
 *   🔍  grep "createFunction" in src/inngest
 *   📁  ls src/lib/almanac
 *   🛠️  bash $ npm run build
 *   💭  reasoning: I need to understand the unit's entry point…
 *   ✍️  agent_message · 274c · "The KAN work is split into…"
 *   🔧  read_file({"path":"package.json"})
 */
function renderCodexItem(
  item: Record<string, unknown>,
  itemType: string,
): { icon: string; label: string } {
  if (itemType === 'reasoning' || itemType === 'thinking') {
    const text = clean((item.text as string | undefined) ?? '');
    return { icon: '💭', label: text ? `reasoning · ${truncate(text, 140)}` : 'reasoning' };
  }

  if (itemType === 'agent_message') {
    const text = clean((item.text as string | undefined) ?? '');
    return { icon: '✍️ ', label: `agent_message · ${text.length}c · "${truncate(text, 100)}"` };
  }

  if (itemType === 'command_execution' || itemType === 'shell_call') {
    const cmd = item.command ?? item.cmd;
    const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
    return summariseShellCommand(cmdStr);
  }

  // Generic tool/function call
  if (itemType === 'function_call' || itemType === 'tool_use') {
    const name = (item.name as string | undefined) ?? '?';
    const argsRaw = item.arguments ?? item.input;
    const args = typeof argsRaw === 'string'
      ? argsRaw
      : argsRaw && typeof argsRaw === 'object' ? safeStringify(argsRaw) : '';
    // Promote known tool names to friendlier renderings
    if (name === 'read_file' || name === 'file_read') return { icon: '📖', label: `read ${pickPath(args) ?? args}` };
    if (name === 'write_file' || name === 'file_write') return { icon: '📝', label: `write ${pickPath(args) ?? args}` };
    if (name === 'grep' || name === 'search') return { icon: '🔍', label: `grep ${pickQuery(args) ?? args}` };
    if (name === 'list_dir' || name === 'ls') return { icon: '📁', label: `ls ${pickPath(args) ?? args}` };
    return { icon: '🔧', label: `${name}(${truncate(args, 100)})` };
  }

  if (itemType === 'function_call_output' || itemType === 'tool_result') {
    const outRaw = item.output ?? item.content;
    const out = typeof outRaw === 'string'
      ? outRaw
      : outRaw && typeof outRaw === 'object' ? safeStringify(outRaw) : '';
    return { icon: '↩️ ', label: `result · ${truncate(clean(out), 100)}` };
  }

  return { icon: '·', label: `${itemType}` };
}

/**
 * Codex tends to wrap every shell call in "/bin/zsh -lc \"…\"". Strip the
 * wrapper, then map the inner command to a meaningful one-line label.
 *
 *   nl -ba file | sed -n '1,380p'   → 📖 read file (lines 1–380)
 *   cat file                        → 📖 read file
 *   rg/grep "pat" path              → 🔍 grep "pat" in path
 *   ls path                         → 📁 ls path
 *   find path -name x               → 🔎 find x under path
 *   anything else                   → 🛠️  $ <cmd, truncated>
 */
function summariseShellCommand(cmdStr: string): { icon: string; label: string } {
  // Strip the typical zsh/bash wrapper that Codex emits.
  const inner = (() => {
    const m = cmdStr.match(/^\/bin\/(?:zsh|bash) -lc\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const m2 = cmdStr.match(/^\/bin\/(?:zsh|bash) -lc\s+'(.*)'\s*$/);
    if (m2) return m2[1];
    return cmdStr;
  })();

  // Pattern: `nl -ba <path> | sed -n 'N,Mp'`  (Codex's preferred read pattern)
  const nlSed = inner.match(/nl\s+-ba\s+'?([^'|]+?)'?\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'/);
  if (nlSed) {
    return { icon: '📖', label: `read ${nlSed[1].trim()} (lines ${nlSed[2]}–${nlSed[3]})` };
  }

  // Pattern: `sed -n 'N,Mp' <path>`
  const sedOnly = inner.match(/sed\s+-n\s+'(\d+),(\d+)p'\s+'?([^'\s]+)'?/);
  if (sedOnly) {
    return { icon: '📖', label: `read ${sedOnly[3]} (lines ${sedOnly[1]}–${sedOnly[2]})` };
  }

  // Pattern: `cat <path>` (with optional flags)
  const catMatch = inner.match(/^\s*cat\s+(?:-[A-Za-z]+\s+)*'?([^'|>\s]+)'?/);
  if (catMatch) {
    return { icon: '📖', label: `read ${catMatch[1]}` };
  }

  // Pattern: `head -n N <path>` / `tail -n N <path>`
  const hMatch = inner.match(/^\s*(head|tail)\s+(?:-n\s+\+?(\d+)\s+)?'?([^'\s]+)'?/);
  if (hMatch) {
    return { icon: '📖', label: `${hMatch[1]} ${hMatch[2] ? `${hMatch[2]} of ` : ''}${hMatch[3]}` };
  }

  // Pattern: rg / grep
  const rgMatch = inner.match(/^\s*(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*'([^']+)'(?:\s+(\S+))?/);
  if (rgMatch) {
    return { icon: '🔍', label: `grep "${rgMatch[1]}"${rgMatch[2] ? ` in ${rgMatch[2]}` : ''}` };
  }
  const rgMatch2 = inner.match(/^\s*(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*"([^"]+)"(?:\s+(\S+))?/);
  if (rgMatch2) {
    return { icon: '🔍', label: `grep "${rgMatch2[1]}"${rgMatch2[2] ? ` in ${rgMatch2[2]}` : ''}` };
  }

  // Pattern: ls / la
  const lsMatch = inner.match(/^\s*ls\s+(?:-[A-Za-z]+\s+)*(\S*)/);
  if (lsMatch) {
    return { icon: '📁', label: `ls ${lsMatch[1] || '.'}` };
  }

  // Pattern: find
  const findMatch = inner.match(/^\s*find\s+(\S+)(?:\s+-name\s+'?([^'\s]+)'?)?/);
  if (findMatch) {
    return {
      icon: '🔎',
      label: `find${findMatch[2] ? ` "${findMatch[2]}"` : ''} under ${findMatch[1]}`,
    };
  }

  // Pattern: wc
  const wcMatch = inner.match(/^\s*wc\s+(?:-[A-Za-z]+\s+)*'?([^'\s]+)'?/);
  if (wcMatch) {
    return { icon: '📏', label: `wc ${wcMatch[1]}` };
  }

  return { icon: '🛠️ ', label: `$ ${truncate(inner, 140)}` };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function pickPath(args: string): string | null {
  const m = args.match(/"path"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function pickQuery(args: string): string | null {
  const m = args.match(/"(?:query|pattern)"\s*:\s*"([^"]+)"/);
  return m ? `"${m[1]}"` : null;
}

/**
 * Run the CLI to completion, accumulate all text-bearing events, and return
 * the concatenated text output.
 *
 * Per-CLI event extraction mirrors the server-side adapters exactly:
 *   - Codex:  { type: "agent_message_delta", delta }
 *             { type: "agent_message", message }
 *             (inner msg envelope: { msg: { type, … } })
 *   - Claude: { type: "stream_event", event: { type: "content_block_delta",
 *               delta: { type: "text_delta", text } } }
 *             { type: "result", result }  (fallback)
 *             { type: "assistant", message.content[].text } (fallback)
 *   - Gemini: { type: "text"|"content"|"delta", text }
 */
export async function runCliJson(opts: CliOptions): Promise<string> {
  const parts: string[] = [];
  let streamedDelta = false; // Claude: suppress duplicate result/assistant text
  const eventTypes = new Map<string, number>();
  let unparseable = 0;

  for await (const line of streamCli(opts)) {
    const evt = tryParse(line);
    if (!evt) {
      unparseable++;
      continue;
    }
    const evtType = (evt.type as string | undefined) ?? '(no type)';
    eventTypes.set(evtType, (eventTypes.get(evtType) ?? 0) + 1);

    // Verbose per-event log so the user can see every tool call, every
    // turn, every reasoning chunk as it happens. Suppress text deltas
    // (would print every keystroke); summarise everything else.
    logCliEvent(opts.cli, evt);

    switch (opts.cli) {
      case "codex": {
        // Codex event shapes have evolved — support all of them:
        //   v0.x flat:    { type: "agent_message", message }
        //                 { type: "agent_message_delta", delta }
        //   v0.x wrapped: { msg: { type: "agent_message", message } }
        //   v0.128+ item: { type: "item.completed",
        //                   item: { type: "agent_message", text } }
        //                 { type: "turn.completed", usage } (no text)
        const t = evt.type as string | undefined;

        // New 0.128+ envelope
        if (t === "item.completed" && typeof evt.item === "object" && evt.item !== null) {
          const item = evt.item as Record<string, unknown>;
          const itemType = item.type as string | undefined;
          if (itemType === "agent_message" && typeof item.text === "string") {
            parts.push(item.text);
          }
          break;
        }

        // Legacy: support both flat and wrapped envelopes
        const msg = (typeof evt.msg === "object" && evt.msg !== null
          ? evt.msg
          : evt) as Record<string, unknown>;
        const lt = (msg.type ?? evt.type) as string | undefined;
        if (lt === "agent_message_delta" && typeof msg.delta === "string") {
          parts.push(msg.delta);
        } else if (lt === "agent_message") {
          // Either { message } (legacy) or { text } (newer flat form)
          if (typeof msg.message === "string") parts.push(msg.message);
          else if (typeof msg.text === "string") parts.push(msg.text);
        }
        break;
      }

      case "claude": {
        if (evt.type === "stream_event") {
          const inner = (evt.event ?? {}) as Record<string, unknown>;
          const delta = inner.delta as { type?: string; text?: string } | undefined;
          if (
            inner.type === "content_block_delta" &&
            delta?.type === "text_delta" &&
            delta.text
          ) {
            streamedDelta = true;
            parts.push(delta.text);
          }
          break;
        }
        if (evt.type === "assistant" && !streamedDelta) {
          const msg = evt.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
          const text = msg?.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (text) parts.push(text);
          break;
        }
        if (evt.type === "result" && !streamedDelta) {
          if (typeof evt.result === "string" && evt.result.trim()) {
            parts.push(evt.result);
          }
          break;
        }
        break;
      }

      case "gemini": {
        const t = evt.type as string | undefined;
        if (
          (t === "text" || t === "content" || t === "delta") &&
          typeof evt.text === "string"
        ) {
          parts.push(evt.text);
        }
        break;
      }
    }
  }

  const totalText = parts.join("");
  // Per-event-type breakdown so the user can see what the CLI emitted
  // vs what we extracted text from. If text=0 here, the parser missed
  // a new event shape and the user can grep eventTypes to see what.
  const breakdown = [...eventTypes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}=${n}`)
    .join(' ');
  console.log(
    `[cli ${opts.cli}] events · text=${totalText.length}c · parts=${parts.length} · unparseable_lines=${unparseable} · ${breakdown}`,
  );
  return totalText;
}
