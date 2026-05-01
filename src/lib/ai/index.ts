import { createAnthropic } from '@ai-sdk/anthropic';
import { getProviderConfig } from './config-store';

export type AITask =
  | 'enrich'
  | 'recap'
  | 'extract'
  | 'project-summary'
  | 'decision'
  | 'narrative';

const TASK_MODELS: Record<AITask, string> = {
  enrich: 'claude-haiku-4-5-20251001',
  recap: 'claude-haiku-4-5-20251001',
  extract: 'claude-haiku-4-5-20251001',
  'project-summary': 'claude-haiku-4-5-20251001',
  decision: 'claude-sonnet-4-6',
  narrative: 'claude-sonnet-4-6',
};

/**
 * Resolve credentials for an AI provider.
 *
 * Lookup order: stored config (settings UI) → process env. Stored values win
 * so a user can override a deployment-default key via the UI without a restart.
 * If the DB is unreachable (fresh install, missing crypto key), we fall back
 * silently to the env so existing deployments keep working.
 */
function resolveAnthropicCredentials(): { apiKey?: string; baseURL?: string } {
  let apiKey: string | undefined = process.env.ANTHROPIC_API_KEY;
  let baseURL: string | undefined = process.env.ANTHROPIC_BASE_URL;
  try {
    const stored = getProviderConfig('anthropic');
    if (stored?.apiKey) apiKey = stored.apiKey;
    if (stored?.baseUrl) baseURL = stored.baseUrl;
  } catch {
    // DB or crypto unavailable — env-only fallback
  }
  return { apiKey, baseURL };
}

export function getModel(task: AITask) {
  const { apiKey, baseURL } = resolveAnthropicCredentials();
  const provider = createAnthropic({ apiKey, baseURL });
  return provider(TASK_MODELS[task]);
}
