import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { getProviderConfig } from './config-store';

export type AITask =
  | 'enrich'
  | 'recap'
  | 'extract'
  | 'project-summary'
  | 'decision'
  | 'narrative';

const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

const TASK_MODELS: Record<AITask, string> = {
  enrich: DEFAULT_MODEL,
  recap: DEFAULT_MODEL,
  extract: DEFAULT_MODEL,
  'project-summary': DEFAULT_MODEL,
  decision: DEFAULT_MODEL,
  narrative: DEFAULT_MODEL,
};

/**
 * Resolve credentials for the active AI provider.
 *
 * Lookup order: stored config (Settings → AI tab) → process env. Stored values
 * win so a user can rotate keys via the UI without restarting the daemon.
 * If the DB or crypto helper is unavailable (fresh install), we fall back
 * silently to env so the runtime still works.
 */
function resolveOpenRouterCredentials(): { apiKey?: string; baseURL?: string } {
  let apiKey: string | undefined = process.env.OPENROUTER_API_KEY;
  let baseURL: string | undefined = process.env.OPENROUTER_BASE_URL;
  try {
    const stored = getProviderConfig('openrouter');
    if (stored?.apiKey) apiKey = stored.apiKey;
    if (stored?.baseUrl) baseURL = stored.baseUrl;
  } catch {
    // DB or crypto unavailable — env-only fallback
  }
  return { apiKey, baseURL };
}

export function getModel(task: AITask) {
  const { apiKey, baseURL } = resolveOpenRouterCredentials();
  const provider = createOpenRouter({ apiKey, baseURL });
  return provider(TASK_MODELS[task]);
}
