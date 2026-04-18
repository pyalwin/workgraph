import { initSchema, seedGoals, seedConfig, seedOttiUsers, seedOttiDeployments } from '../src/lib/schema';
import { getDb } from '../src/lib/db';
import { ingestOttiSessions, DEFAULT_OTTI_SESSIONS_SOURCE } from './ingest-otti-sessions';

console.log('Initializing database...');
initSchema();
seedGoals();
seedConfig();
seedOttiUsers();
seedOttiDeployments();

// Re-ingest Otti session transcripts (raw data, re-hydrates after reset).
// Safe to skip if the transcripts directory is absent.
const sessionResult = ingestOttiSessions();
if (sessionResult.skipped) {
  console.log(`Otti sessions: skipped (${sessionResult.reason})`);
} else {
  console.log(`Otti sessions ingested: ${sessionResult.total} (errors: ${sessionResult.errors}, dirs: ${Object.keys(sessionResult.perDate).length})`);
}

const db = getDb();
const goals = db.prepare('SELECT id, name FROM goals').all();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
const config = db.prepare("SELECT config FROM sync_config WHERE id = 'default'").get() as any;
const userCount = (db.prepare('SELECT COUNT(*) AS c FROM otti_users').get() as any).c;
const deployCount = (db.prepare('SELECT COUNT(*) AS c FROM otti_deployments').get() as any).c;
const sessionCount = (db.prepare('SELECT COUNT(*) AS c FROM otti_sessions').get() as any).c;

console.log(`\nTables created: ${tables.map(t => t.name).join(', ')}`);
console.log(`Goals seeded: ${(goals as any[]).map((g: any) => g.name).join(', ')}`);
console.log(`Otti users seeded: ${userCount}`);
console.log(`Otti deployments seeded: ${deployCount}`);
console.log(`Otti sessions in DB: ${sessionCount} (source: ${DEFAULT_OTTI_SESSIONS_SOURCE})`);
console.log(`Config: ${JSON.stringify(JSON.parse(config.config).jira.projects)}`);
console.log('Database ready.');
