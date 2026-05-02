import type { CliBackend, CliBackendOptions, CliEvent } from './types';
import { isOnPath, spawnCliLines, tryParseJson } from './utils';

/**
 * Codex CLI adapter. Uses `codex exec --json <prompt>` to emit JSONL events.
 * Codex's event shapes vary by version; we extract text from common fields:
 *   - { type: "agent_message", message }
 *   - { msg: { type: "agent_message_delta", delta } }
 *   - { type: "task_complete", ... }
 */
async function* streamCodex(opts: CliBackendOptions): AsyncIterable<CliEvent> {
  const args = ['exec', '--json'];
  if (opts.model) args.push('-c', `model="${opts.model}"`);
  if (opts.disableTools) {
    // Lock Codex to read-only sandbox so it can't shell out / edit files
    // during a workflow summarization call.
    args.push('--sandbox', 'read-only');
  }
  // Pass system prompt prepended to the user prompt (codex has no first-class --system flag).
  const prompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  args.push(prompt);

  const gen = spawnCliLines('codex', args, { cwd: opts.cwd, signal: opts.signal });

  for await (const line of gen) {
    const evt = tryParseJson(line) as Record<string, unknown> | null;
    if (!evt) continue;

    // Newer event envelope: { id, msg: { type, ... } }
    const msg = (evt.msg ?? evt) as Record<string, unknown>;
    const t = (msg.type ?? evt.type) as string | undefined;

    if (t === 'agent_message_delta' && typeof msg.delta === 'string') {
      yield { type: 'text-delta', text: msg.delta };
      continue;
    }
    if (t === 'agent_message' && typeof msg.message === 'string') {
      yield { type: 'text-delta', text: msg.message };
      continue;
    }
    if (t === 'task_complete' || t === 'turn_complete') {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (t === 'error' && typeof msg.message === 'string') {
      yield { type: 'error', message: msg.message };
      return;
    }
  }

  yield { type: 'finish', reason: 'stop' };
}

export const codexBackend: CliBackend = {
  id: 'codex',
  label: 'Codex',
  isAvailable: () => isOnPath('codex'),
  stream: streamCodex,
};
