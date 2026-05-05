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
