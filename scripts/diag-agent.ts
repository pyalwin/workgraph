/**
 * Quick diagnostic for the local-agent flow.
 * Usage: npx tsx scripts/diag-agent.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { createClient } from '@libsql/client';

dotenvConfig({ path: '.env.local' });
dotenvConfig({ path: '.env' });

async function main() {
  const url = process.env.DATABASE_URL ?? 'file:./data/workgraph.db';
  console.log('DATABASE_URL:', url);
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  const sections: Array<[string, string]> = [
    ['agents', 'SELECT id, workspace_id, hostname, last_seen_at FROM agents ORDER BY paired_at DESC'],
    ['recent agent_jobs', "SELECT id, kind, status, workspace_id, assigned_to, attempt, substr(created_at, 12, 8) AS at FROM agent_jobs ORDER BY created_at DESC LIMIT 10"],
    ['recent almanac_docs', 'SELECT id, project_key, repo_key, ref, status, workspace_id FROM almanac_docs ORDER BY created_at DESC LIMIT 5'],
    ['recent job_events', "SELECT job_id, seq, type, substr(created_at, 12, 8) AS at FROM job_events ORDER BY job_id, seq DESC LIMIT 15"],
  ];

  for (const [label, sql] of sections) {
    console.log(`\n── ${label} ──`);
    try {
      const r = await client.execute(sql);
      if (r.rows.length === 0) {
        console.log('(none)');
        continue;
      }
      for (const row of r.rows) {
        console.log(JSON.stringify(row));
      }
    } catch (err) {
      console.error('  ERROR:', err instanceof Error ? err.message : err);
    }
  }

  console.log('\nIf agents.workspace_id !== almanac_docs.workspace_id, the agent will never see the job.');
  client.close();
}

void main();
