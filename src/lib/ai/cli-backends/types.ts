/**
 * CLI backend abstraction — lets the chat route invoke local agentic CLIs
 * (Claude Code, Codex, Gemini CLI) as alternative backends to the in-process
 * Vercel AI SDK. Inspired by https://github.com/hilash/cabinet.
 *
 * Each backend spawns its CLI in non-interactive print/exec mode with JSON
 * output, parses the stream, and yields a normalized event sequence the
 * server route bridges into AI-SDK UIMessage chunks.
 */

export type CliEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; toolCallId: string; name: string; input?: unknown }
  | { type: 'tool-end'; toolCallId: string; output?: unknown; error?: string }
  | { type: 'finish'; reason?: string; usage?: { input?: number; output?: number } }
  | { type: 'error'; message: string };

export interface CliBackendOptions {
  /** Composed user+assistant transcript collapsed to a single prompt for the CLI. */
  prompt: string;
  /** System prompt — passed via the CLI's --system-prompt / equivalent flag. */
  systemPrompt: string;
  /** Optional working directory the CLI should run in. */
  cwd?: string;
  /** Optional model override (e.g. "claude-opus-4", "o3", "gemini-2.5-pro"). */
  model?: string;
  /** Abort signal forwarded from the request. */
  signal?: AbortSignal;
  /**
   * Disable agentic tool use (Bash / Read / Edit / Grep / Write / WebFetch /
   * etc.). Set true for one-shot summarization workflows where the model
   * should only read the prompt and emit text. Defaults to false (chat use).
   */
  disableTools?: boolean;
}

export interface CliBackend {
  /** Stable id used in the API request body to select this backend. */
  id: 'claude' | 'codex' | 'gemini';
  /** Human label for UIs. */
  label: string;
  /** Fast, cached check that the binary is on PATH. */
  isAvailable(): Promise<boolean>;
  /** Async iterable of normalized events. Caller must consume to completion. */
  stream(opts: CliBackendOptions): AsyncIterable<CliEvent>;
}
