import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';

const DB_PATH = path.join(process.cwd(), '..', 'workgraph.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    try {
      sqliteVec.load(_db);
    } catch (err: any) {
      console.warn(`sqlite-vec load failed: ${err.message}. Vector search unavailable.`);
    }
  }
  return _db;
}
