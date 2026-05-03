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

  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward stderr for debugging without polluting the JSONL stream.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[almanac-classify ${binary} stderr] ${chunk.toString()}`);
  });

  const onAbort = (): void => { child.kill("SIGTERM"); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // Wait for the process to fully exit (ignore the code — callers handle
  // partial output gracefully by skipping non-JSON lines).
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("close", () => resolve());
  });
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

  for await (const line of streamCli(opts)) {
    const evt = tryParse(line);
    if (!evt) continue;

    switch (opts.cli) {
      case "codex": {
        // Support both flat { type, … } and wrapped { msg: { type, … } }
        const msg = (typeof evt.msg === "object" && evt.msg !== null
          ? evt.msg
          : evt) as Record<string, unknown>;
        const t = (msg.type ?? evt.type) as string | undefined;

        if (t === "agent_message_delta" && typeof msg.delta === "string") {
          parts.push(msg.delta);
        } else if (t === "agent_message" && typeof msg.message === "string") {
          parts.push(msg.message);
        }
        // task_complete / turn_complete — no text to extract, just stop signals
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

  return parts.join("");
}
