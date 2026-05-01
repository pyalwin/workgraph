import { createGateway } from '@ai-sdk/gateway';
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
 * Resolve credentials for the Vercel AI Gateway — a managed router that
 * fronts OpenAI / Anthropic / Google / Mistral / etc. behind one endpoint
 * and one key (`vck_...`).
 *
 * Lookup order: stored config (Settings → AI tab) → process env. Stored
 * values win so a key can be rotated via the UI without restarting.
 * Trims to defend against trailing-newline paste artifacts that turn
 * `Bearer vck_…\n` into a malformed Authorization header.
 */
function resolveGatewayCredentials(): { apiKey?: string; baseURL?: string } {
  let apiKey: string | undefined = process.env.AI_GATEWAY_API_KEY?.trim();
  let baseURL: string | undefined = process.env.AI_GATEWAY_BASE_URL?.trim();
  let source: 'env' | 'db' | 'none' = apiKey ? 'env' : 'none';
  try {
    const stored = getProviderConfig('gateway');
    if (stored?.apiKey) {
      apiKey = stored.apiKey.trim();
      source = 'db';
    }
    if (stored?.baseUrl) baseURL = stored.baseUrl.trim();
  } catch (err) {
    console.warn(`[ai] getProviderConfig('gateway') failed:`, (err as Error).message);
  }

  if (!apiKey) {
    console.warn(
      `[ai] No Vercel AI Gateway key resolved (source=${source}). Set AI_GATEWAY_API_KEY or use Settings → AI.`,
    );
  }
  return { apiKey, baseURL };
}

export function getModel(task: AITask) {
  const { apiKey, baseURL } = resolveGatewayCredentials();
  const provider = createGateway({ apiKey, baseURL });
  return provider(TASK_MODELS[task]);
}
