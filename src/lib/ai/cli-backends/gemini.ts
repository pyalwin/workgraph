import type { CliBackend, CliBackendOptions, CliEvent } from './types';
import { isOnPath, spawnCliLines, tryParseJson } from './utils';

/**
 * Gemini CLI adapter. Uses `gemini -p <prompt> -o stream-json --yolo`.
 * --yolo auto-approves tool actions (we run as a non-interactive backend
 * so prompting wouldn't work anyway). Event shapes (Gemini-specific):
 *   - { type: "text", text }
 *   - { type: "tool_call", ... }
 *   - { type: "complete", ... }
 */
async function* streamGemini(opts: CliBackendOptions): AsyncIterable<CliEvent> {
  const args = ['-p', opts.prompt, '-o', 'stream-json'];
  // For agentic chat use we --yolo to auto-approve. For workflow summarization
  // we use --approval-mode plan (read-only) and skip --yolo.
  if (opts.disableTools) {
    args.push('--approval-mode', 'plan');
  } else {
    args.push('--yolo');
  }
  if (opts.model) args.push('-m', opts.model);

  // Gemini CLI has no system-prompt flag; prepend to prompt.
  if (opts.systemPrompt) {
    const idx = args.indexOf(opts.prompt);
    args[idx] = `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`;
  }

  const gen = spawnCliLines('gemini', args, { cwd: opts.cwd, signal: opts.signal });

  for await (const line of gen) {
    const evt = tryParseJson(line) as Record<string, unknown> | null;
    if (!evt) continue;

    const t = evt.type as string | undefined;
    if ((t === 'text' || t === 'content') && typeof evt.text === 'string') {
      yield { type: 'text-delta', text: evt.text };
      continue;
    }
    if (t === 'delta' && typeof evt.text === 'string') {
      yield { type: 'text-delta', text: evt.text };
      continue;
    }
    if (t === 'complete' || t === 'done' || t === 'finish') {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (t === 'error' && typeof evt.message === 'string') {
      yield { type: 'error', message: evt.message };
      return;
    }
  }

  yield { type: 'finish', reason: 'stop' };
}

export const geminiBackend: CliBackend = {
  id: 'gemini',
  label: 'Gemini',
  isAvailable: () => isOnPath('gemini'),
  stream: streamGemini,
};
