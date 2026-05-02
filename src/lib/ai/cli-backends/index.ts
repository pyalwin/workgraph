import type { CliBackend } from './types';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { geminiBackend } from './gemini';

export type { CliBackend, CliBackendOptions, CliEvent } from './types';

export const CLI_BACKENDS: Record<string, CliBackend> = {
  claude: claudeBackend,
  codex: codexBackend,
  gemini: geminiBackend,
};

export type BackendId = 'sdk' | 'claude' | 'codex' | 'gemini';

export function getCliBackend(id: string): CliBackend | null {
  return CLI_BACKENDS[id] ?? null;
}

export async function listAvailableBackends(): Promise<
  Array<{ id: BackendId; label: string; available: boolean }>
> {
  const cli = await Promise.all(
    Object.values(CLI_BACKENDS).map(async (b) => ({
      id: b.id as BackendId,
      label: b.label,
      available: await b.isAvailable(),
    })),
  );
  return [{ id: 'sdk', label: 'Vercel AI SDK', available: true }, ...cli];
}
