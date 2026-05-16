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
const HOSTED_DEFAULT_URL = 'https://workgraph.space';
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

  // If a service was installed by a previous pairing, stop + uninstall it
  // BEFORE we mint a new token. Otherwise the launchd/systemd process keeps
  // running with the old token and hammers the server with 401s every few
  // seconds — exactly the bug that prompted this guard. The fresh pairing
  // can re-install the service afterwards (same prompt as a first install).
  try {
    const { getInstaller } = await import('../service/index.js');
    const installer = getInstaller();
    if (installer) {
      const status = await installer.status();
      if (status.installed) {
        console.log('Stopping previously-installed background service before re-pairing...');
        await installer.uninstall();
      }
    }
  } catch (err) {
    // Best-effort. If the uninstall path fails we still want to let the
    // user re-pair; they can clean up the orphan service manually.
    console.warn(
      'Could not stop the existing background service automatically:',
      err instanceof Error ? err.message : String(err),
    );
  }

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

      // Offer to install as a background service so the user doesn't have
      // to keep a terminal open. Only on supported OSes; skip the prompt
      // entirely on Windows / other platforms.
      const { getInstaller } = await import('../service/index.js');
      const installer = getInstaller();
      if (installer && (await shouldOfferService())) {
        const yes = await confirmYes(
          '\nInstall the agent as a background service so it runs automatically? [Y/n] ',
        );
        if (yes) {
          try {
            const { realpathSync } = await import('node:fs');
            const binaryPath = (() => {
              try { return realpathSync(process.argv[1]); }
              catch { return process.argv[1]; }
            })();
            await installer.install({ binaryPath, nodePath: process.execPath });
            console.log(`✓ Background service installed and started.`);
            console.log(`  Status: workgraph service status`);
            console.log(`  Logs:   workgraph service logs`);
          } catch (err) {
            console.error(`Service install failed: ${err instanceof Error ? err.message : String(err)}`);
            console.error(`You can still run the agent manually with: workgraph run`);
          }
        } else {
          console.log('Run `workgraph run` to start accepting jobs (or `workgraph service install` later).');
        }
      } else {
        console.log('Run `workgraph run` to start accepting jobs.');
      }
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

/**
 * Only offer the service install when:
 *   - stdin is a TTY (we can actually read a y/n answer), AND
 *   - the user didn't pass `--no-service` to opt out, AND
 *   - WORKGRAPH_NO_SERVICE env var is not set.
 * Always skip for CI / non-interactive environments.
 */
async function shouldOfferService(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  if (process.argv.includes('--no-service')) return false;
  if (process.env['WORKGRAPH_NO_SERVICE']) return false;
  return true;
}

/**
 * Tiny y/n prompt — defaults to yes on Enter. Returns false on Ctrl-D or
 * any non-y answer (n / no / anything else).
 */
function confirmYes(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const answer = chunk.toString().trim().toLowerCase();
      resolve(answer === '' || answer === 'y' || answer === 'yes');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}
