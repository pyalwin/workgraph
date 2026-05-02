import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });
config({ path: join(process.cwd(), '.env') });

import('../src/lib/ai/config-store').then(async ({ getProviderConfig }) => {
  const cfg = await getProviderConfig('openrouter');
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
});
