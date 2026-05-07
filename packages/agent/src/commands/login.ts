import { apiFetchPublic } from '../client.js';
import { writeConfig } from '../config.js';

/**
 * Server URL resolution order:
 *   1. `--url <url>` flag
 *   2. `--dev` flag → DEV_BASE_URL (localhost convenience for local development)
 *   3. `WORKGRAPH_SERVER_URL` env var
 *   4. HOSTED_DEFAULT_URL (the public hosted Workgraph instance)
 *
 * Self-hosters either pass `--url https://their-instance.example.com` or
 * set `WORKGRAPH_SERVER_URL` once in their shell rc. Most users hit the
 * hosted default and never think about it.
 */
const HOSTED_DEFAULT_URL = 'https://workgraph-beta.vercel.app';
const DEV_BASE_URL = 'http://localhost:3000';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PairStartResponse {
  pairing_id: string;
  user_code: string;
  verification_url: string;
}

interface PairPollResponse {
  status: 'pending' | 'confirmed' | 'expired';
  agent_id?: string;
  agent_token?: string;
}

export async function loginCommand(argv: string[]): Promise<void> {
  const baseUrl = resolveBaseUrl(argv);

  console.log(`\nUsing server: ${baseUrl}`);

  // Step 1: Start device-flow pairing.
  let startRes: PairStartResponse;
  try {
    startRes = (await apiFetchPublic(baseUrl, '/api/agent/pair/start', {
      method: 'POST',
      body: {},
    })) as PairStartResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start pairing: ${msg}`);
    console.error(`\nIf the server URL above is wrong, retry with:`);
    console.error(`  workgraph login --url <your server>`);
    console.error(`Or set WORKGRAPH_SERVER_URL in your shell.`);
    process.exit(1);
  }

  const { pairing_id, user_code, verification_url } = startRes;

  console.log('\nTo pair this machine with Workgraph:\n');
  console.log(`  Open: ${verification_url}`);
  console.log(`  Enter code: ${user_code}\n`);
  console.log('Waiting for confirmation...');

  // Step 2: Poll until confirmed or expired.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollRes: PairPollResponse;
    try {
      pollRes = (await apiFetchPublic(baseUrl, '/api/agent/pair/poll', {
        method: 'POST',
        body: { pairing_id },
      })) as PairPollResponse;
    } catch (err) {
      // Network errors during polling — log and keep trying.
      console.warn('Poll error (retrying):', err instanceof Error ? err.message : String(err));
      continue;
    }

    if (pollRes.status === 'confirmed') {
      if (!pollRes.agent_id || !pollRes.agent_token) {
        console.error('Server returned confirmed but missing agent_id or agent_token.');
        process.exit(1);
      }
      await writeConfig({
        agent_id: pollRes.agent_id,
        agent_token: pollRes.agent_token,
        base_url: baseUrl,
        paired_at: new Date().toISOString(),
      });
      console.log(`\nPaired successfully. Agent ID: ${pollRes.agent_id}`);
      console.log('Run `workgraph run` to start accepting jobs.');
      return;
    }

    if (pollRes.status === 'expired') {
      console.error('\nPairing code expired. Run `workgraph login` again.');
      process.exit(1);
    }

    // status === 'pending' — keep polling.
    process.stdout.write('.');
  }

  console.error('\nTimed out waiting for confirmation. Run `workgraph login` again.');
  process.exit(1);
}

export function resolveBaseUrl(argv: string[]): string {
  const fromFlag = parseUrlFlag(argv);
  if (fromFlag) return normalize(fromFlag);

  if (argv.includes('--dev')) return DEV_BASE_URL;

  const fromEnv = process.env['WORKGRAPH_SERVER_URL']?.trim();
  if (fromEnv) return normalize(fromEnv);

  return HOSTED_DEFAULT_URL;
}

function parseUrlFlag(argv: string[]): string | null {
  const idx = argv.indexOf('--url');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  return null;
}

function normalize(url: string): string {
  // Strip trailing slash so paths concat cleanly later.
  return url.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
