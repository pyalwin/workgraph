import { getProviderConfig } from '../src/lib/ai/config-store';

const cfg = getProviderConfig('openrouter');
console.log(
  'cfg:',
  cfg
    ? {
        hasKey: cfg.hasKey,
        baseUrl: cfg.baseUrl,
        apiKeyLen: cfg.apiKey?.length,
        apiKeyHead: cfg.apiKey?.slice(0, 6),
      }
    : null,
);
console.log('env OPENROUTER_API_KEY len:', process.env.OPENROUTER_API_KEY?.length ?? 'undefined');
