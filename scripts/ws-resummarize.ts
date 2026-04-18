import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { summarizeAllWorkstreams } from '../src/lib/workstream/summary';

async function main() {
  const r = await summarizeAllWorkstreams({ force: true, minItems: 2, concurrency: 2 });
  console.log('result:', r);
}

main();
