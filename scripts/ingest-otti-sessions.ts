import { getDb } from '../src/lib/db';
import { initSchema, seedOttiDeployments } from '../src/lib/schema';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SOURCE = path.join(
  process.env.HOME || '~',
  'Documents/code/ottiassistant/data/transcripts/sessions'
);

function main() {
  const sourceDir = process.argv[2] || DEFAULT_SOURCE;
  console.log(`Ingesting sessions from: ${sourceDir}`);

  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  initSchema();
  seedOttiDeployments();
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO otti_sessions (id, ts_start, ts_end, user_id, channel_id, persona, intent, agent_type, model, repo_name, num_events, duration_s)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ts_start=excluded.ts_start, ts_end=excluded.ts_end, user_id=excluded.user_id,
      channel_id=excluded.channel_id, persona=excluded.persona, intent=excluded.intent,
      agent_type=excluded.agent_type, model=excluded.model, repo_name=excluded.repo_name,
      num_events=excluded.num_events, duration_s=excluded.duration_s
  `);

  const dateDirs = fs.readdirSync(sourceDir).filter(d =>
    fs.statSync(path.join(sourceDir, d)).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d)
  ).sort();

  let total = 0;
  let errors = 0;

  const insertMany = db.transaction((rows: any[]) => {
    for (const r of rows) {
      upsert.run(r.id, r.ts_start, r.ts_end, r.user_id, r.channel_id, r.persona, r.intent, r.agent_type, r.model, r.repo_name, r.num_events, r.duration_s);
    }
  });

  for (const dateDir of dateDirs) {
    const dirPath = path.join(sourceDir, dateDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    const batch: any[] = [];

    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(dirPath, file), 'utf-8').trim().split('\n');
        if (lines.length === 0 || !lines[0]) continue;

        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[lines.length - 1]);

        const tsStart = first.ts || '';
        const tsEnd = last.ts || tsStart;

        let durationS = 0;
        try {
          durationS = (new Date(tsEnd).getTime() - new Date(tsStart).getTime()) / 1000;
          if (durationS < 0) durationS = 0;
        } catch { /* keep 0 */ }

        batch.push({
          id: first.task_id || path.basename(file, '.jsonl'),
          ts_start: tsStart,
          ts_end: tsEnd,
          user_id: first.user_id || '',
          channel_id: first.channel_id || '',
          persona: first.persona || 'unknown',
          intent: first.intent || 'unknown',
          agent_type: first.agent_type || 'unknown',
          model: first.model || 'unknown',
          repo_name: first.repo_name || null,
          num_events: lines.length,
          duration_s: durationS,
        });
        total++;
      } catch (e) {
        errors++;
      }
    }

    if (batch.length > 0) {
      insertMany(batch);
      console.log(`  ${dateDir}: ${batch.length} sessions`);
    }
  }

  const count = (db.prepare('SELECT COUNT(*) as c FROM otti_sessions').get() as { c: number }).c;
  console.log(`\nDone. Ingested ${total} sessions (${errors} errors). Total in DB: ${count}`);
}

main();
