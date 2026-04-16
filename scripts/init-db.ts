import { initSchema, seedGoals, seedConfig } from '../src/lib/schema';
import { getDb } from '../src/lib/db';

console.log('Initializing database...');
initSchema();
seedGoals();
seedConfig();

const db = getDb();
const goals = db.prepare('SELECT id, name FROM goals').all();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
const config = db.prepare("SELECT config FROM sync_config WHERE id = 'default'").get() as any;

console.log(`Tables created: ${tables.map(t => t.name).join(', ')}`);
console.log(`Goals seeded: ${(goals as any[]).map((g: any) => g.name).join(', ')}`);
console.log(`Config: ${JSON.stringify(JSON.parse(config.config).jira.projects)}`);
console.log('Database ready.');
