import { createGateway } from '@ai-sdk/gateway';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import { getSettingCached } from '../app-settings';
import { getProviderConfigCached } from './config-store';
import { meteringMiddleware } from './metering-middleware';

export type AITask =
  | 'enrich'
  | 'recap'
  | 'extract'
  | 'project-summary'
  | 'decision'
  | 'narrative'
  | 'chat';

export type AIProviderId = 'gateway' | 'openrouter';

const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
const CHAT_MODEL = 'google/gemini-2.5-flash';

const TASK_MODELS: Record<AITask, string> = {
  enrich: DEFAULT_MODEL,
  recap: DEFAULT_MODEL,
  extract: DEFAULT_MODEL,
  'project-summary': DEFAULT_MODEL,
  decision: DEFAULT_MODEL,
  narrative: DEFAULT_MODEL,
  chat: CHAT_MODEL,
};

interface Credentials {
  apiKey?: string;
  baseURL?: string;
  source: 'env' | 'db' | 'none';
}

function readCredentials(providerId: AIProviderId): Credentials {
  const envKeyVar = providerId === 'openrouter' ? 'OPENROUTER_API_KEY' : 'AI_GATEWAY_API_KEY';
  const envBaseVar = providerId === 'openrouter' ? 'OPENROUTER_BASE_URL' : 'AI_GATEWAY_BASE_URL';

  let apiKey: string | undefined = process.env[envKeyVar]?.trim();
  let baseURL: string | undefined = process.env[envBaseVar]?.trim();
  let source: Credentials['source'] = apiKey ? 'env' : 'none';

  try {
    // Sync cache read — populated on first async lookup and refreshed on
    // every save through the Settings UI.
    const stored = getProviderConfigCached(providerId);
    if (stored?.apiKey) {
      apiKey = stored.apiKey.trim();
      source = 'db';
    }
    if (stored?.baseUrl) baseURL = stored.baseUrl.trim();
  } catch (err) {
    console.warn(`[ai] getProviderConfigCached('${providerId}') failed:`, (err as Error).message);
  }

  return { apiKey, baseURL, source };
}

/**
 * Pick the active provider for this request. Resolution:
 *   1. WORKGRAPH_AI_PROVIDER env override (`gateway` | `openrouter`) — for ops/CI.
 *   2. UI preference saved in app_settings as 'ai.active_provider'.
 *   3. Implicit: if OpenRouter has a key configured but Gateway doesn't,
 *      switch to OpenRouter — matches user intent of pasting one BYOK key.
 *   4. Default: gateway.
 */
function getActiveProvider(): AIProviderId {
  const env = process.env.WORKGRAPH_AI_PROVIDER?.trim().toLowerCase();
  if (env === 'openrouter' || env === 'gateway') return env;

  try {
    // Sync cache read — populated on app boot via the async getSetting path
    // and refreshed on writes through setSetting (see app-settings.ts). The
    // very first request after boot may see null and fall through to the
    // implicit logic below; subsequent requests are correct.
    const stored = getSettingCached('ai.active_provider');
    if (stored === 'openrouter' || stored === 'gateway') return stored;
  } catch {
    // cache read shouldn't throw, but stay defensive
  }

  try {
    const gw = readCredentials('gateway');
    const or = readCredentials('openrouter');
    if (or.apiKey && !gw.apiKey) return 'openrouter';
  } catch {
    // fall through to default
  }
  return 'gateway';
}

export function getModel(task: AITask) {
  const providerId = getActiveProvider();
  const { apiKey, baseURL, source } = readCredentials(providerId);

  if (!apiKey) {
    console.warn(
      `[ai] No API key resolved for provider=${providerId} (source=${source}). ` +
        `Set ${providerId === 'openrouter' ? 'OPENROUTER_API_KEY' : 'AI_GATEWAY_API_KEY'} or use Settings → AI.`,
    );
  }

  const modelId = TASK_MODELS[task];

  let baseModel;
  if (providerId === 'openrouter') {
    const provider = createOpenRouter({
      apiKey,
      baseURL,
      appName: 'WorkGraph',
      appUrl: 'https://github.com/pyalwin/workgraph',
    });
    baseModel = provider(modelId);
  } else {
    const provider = createGateway({ apiKey, baseURL });
    baseModel = provider(modelId);
  }

  // Metering wrapper meters every AI call regardless of caller path —
  // sync, project-summary, decisions, narratives, chat. No-op for BYOK.
  // Pass modelId so the middleware can compute cost from the pricing map.
  return wrapLanguageModel({ model: baseModel, middleware: meteringMiddleware(task, modelId) });
}

export function getActiveProviderId(): AIProviderId {
  return getActiveProvider();
}
