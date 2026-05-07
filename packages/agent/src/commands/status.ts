import { hostname, platform } from 'node:os';
import { readConfig } from '../config.js';
import { apiFetch } from '../client.js';
import { detectClaudeCli } from './run.js';
import { AGENT_VERSION } from '../version.js';

export async function statusCommand(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.log('Not paired. Run `workgraph login` to pair this machine.');
    return;
  }

  console.log('Agent status:');
  console.log(`  Agent ID:    ${config.agent_id}`);
  console.log(`  Server:      ${config.base_url}`);
  console.log(`  Paired at:   ${config.paired_at}`);

  // Optionally verify the token is still valid by hitting heartbeat.
  try {
    const claudeCli = await detectClaudeCli();
    await apiFetch(
      '/api/agent/heartbeat',
      {
        method: 'POST',
        body: {
          hostname: hostname(),
          platform: platform(),
          version: AGENT_VERSION,
          claude_cli: claudeCli,
        },
      },
      config,
    );
    console.log('  Token:       valid (heartbeat OK)');
  } catch (err) {
    console.log(
      `  Token:       error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
