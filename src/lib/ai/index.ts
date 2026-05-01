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
  let apiKey: string | undefined = process.env.OPENROUTER_API_KEY?.trim();
  let baseURL: string | undefined = process.env.OPENROUTER_BASE_URL?.trim();
  let source: 'env' | 'db' | 'none' = apiKey ? 'env' : 'none';
  try {
    const stored = getProviderConfig('openrouter');
    if (stored?.apiKey) {
      // Trim — pasted keys often have trailing whitespace or newlines that
      // break the Authorization header.
      apiKey = stored.apiKey.trim();
      source = 'db';
    }
    if (stored?.baseUrl) baseURL = stored.baseUrl.trim();
  } catch (err) {
    // DB or crypto unavailable — env-only fallback. Surface the why so
    // it doesn't get diagnosed as "Missing Authentication header" later.
    console.warn(`[ai] getProviderConfig('openrouter') failed:`, (err as Error).message);
  }

  if (!apiKey) {
    console.warn(`[ai] No OpenRouter key resolved — source=${source}. Set one in Settings → AI or via OPENROUTER_API_KEY.`);
  }
  return { apiKey, baseURL };
}

export function getModel(task: AITask) {
  const { apiKey, baseURL } = resolveOpenRouterCredentials();
  const provider = createOpenRouter({ apiKey, baseURL });
  return provider(TASK_MODELS[task]);
}
