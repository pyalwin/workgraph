import { initSchema, seedGoals } from '../src/lib/schema';
import { getDb } from '../src/lib/db';

console.log('Initializing database...');
initSchema();
seedGoals();

const db = getDb();
const goals = db.prepare('SELECT id, name FROM goals').all();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];

console.log(`Tables created: ${tables.map(t => t.name).join(', ')}`);
console.log(`Goals seeded: ${(goals as any[]).map((g: any) => g.name).join(', ')}`);
console.log('Database ready.');
