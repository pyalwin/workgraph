#!/usr/bin/env tsx
/**
 * Smoke-test a connector adapter end-to-end without polluting the DB.
 *
 * Usage:
 *   bunx tsx scripts/smoke-test-connector.ts <connector> [--workspace=<id>] [--fixture=<path>]
 *
 * If --fixture is omitted, the script reads JSON from stdin.
 *
 * The runner:
 *   1. Captures all (source, source_id) pairs that exist BEFORE the sync
 *   2. Pipes the fixture through `sync-mcp.ts <connector> --from-stdin`
 *   3. Inspects what was newly inserted (items + links)
 *   4. Deletes ONLY those new rows in a single transaction
 *   5. Returns a structured report so CI / dev loops can assert on it
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { getDb } from '../src/lib/db';
import { initSchema } from '../src/lib/schema';
import { getConnector } from '../src/lib/connectors/registry';

interface CliFlags {
  connector: string | null;
  workspaceId: string;
  fixturePath: string | null;
  keep: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    connector: null,
    workspaceId: 'smoke-test',
    fixturePath: null,
    keep: false,
  };
  for (const arg of argv) {
    if (arg === '--keep') flags.keep = true;
    else if (arg.startsWith('--workspace=')) flags.workspaceId = arg.slice('--workspace='.length);
    else if (arg.startsWith('--fixture=')) flags.fixturePath = arg.slice('--fixture='.length);
    else if (!arg.startsWith('-') && !flags.connector) flags.connector = arg;
  }
  return flags;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

interface ItemSnapshot {
  source: string;
  source_id: string;
  id: string;
}

function snapshotItems(source: string): Set<string> {
  const db = getDb();
  const rows = db.prepare('SELECT source_id FROM work_items WHERE source = ?').all(source) as { source_id: string }[];
  return new Set(rows.map((r) => r.source_id));
}

function snapshotLinks(itemIds: string[]): Set<string> {
  if (itemIds.length === 0) return new Set();
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`,
  ).all(...itemIds, ...itemIds) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

function newItemsSince(source: string, before: Set<string>): ItemSnapshot[] {
  const db = getDb();
  const rows = db.prepare('SELECT id, source_id FROM work_items WHERE source = ?').all(source) as { id: string; source_id: string }[];
  return rows
    .filter((r) => !before.has(r.source_id))
    .map((r) => ({ source, source_id: r.source_id, id: r.id }));
}

function cleanup(source: string, beforeItems: Set<string>, beforeLinks: Set<string>): { items: number; links: number; versions: number } {
  const db = getDb();
  const newItems = newItemsSince(source, beforeItems);
  const newItemIds = newItems.map((i) => i.id);

  let items = 0, links = 0, versions = 0;

  const tx = db.transaction(() => {
    if (newItemIds.length > 0) {
      // Find any new links involving these items.
      const allLinks = snapshotLinks(newItemIds);
      const newLinks: string[] = [];
      for (const lid of allLinks) {
        if (!beforeLinks.has(lid)) newLinks.push(lid);
      }
      // Delete in chunks (SQLite parameter cap).
      for (let i = 0; i < newLinks.length; i += 500) {
        const chunk = newLinks.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM links WHERE id IN (${ph})`).run(...chunk);
        links += r.changes;
      }
      // Delete child rows + items
      for (let i = 0; i < newItemIds.length; i += 500) {
        const chunk = newItemIds.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        const vr = db.prepare(`DELETE FROM work_item_versions WHERE item_id IN (${ph})`).run(...chunk);
        versions += vr.changes;
        db.prepare(`DELETE FROM item_tags WHERE item_id IN (${ph})`).run(...chunk);
        const ir = db.prepare(`DELETE FROM work_items WHERE id IN (${ph})`).run(...chunk);
        items += ir.changes;
      }
    }
  });
  tx();
  return { items, links, versions };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.connector) {
    console.error('Usage: tsx scripts/smoke-test-connector.ts <connector> [--workspace=<id>] [--fixture=<path>] [--keep]');
    process.exit(1);
  }

  const connector = getConnector(flags.connector);
  initSchema();

  // Snapshot BEFORE
  const beforeItems = snapshotItems(connector.source);
  // For links: snapshot every link that touches any pre-existing item of this source.
  const db = getDb();
  const preItemIds = (db.prepare('SELECT id FROM work_items WHERE source = ?').all(connector.source) as { id: string }[]).map((r) => r.id);
  const beforeLinks = snapshotLinks(preItemIds);

  // Read fixture
  const fixture = flags.fixturePath
    ? readFileSync(path.resolve(flags.fixturePath), 'utf-8')
    : await readStdin();
  if (!fixture) {
    console.error('[smoke-test] No fixture provided (use --fixture or pipe via stdin)');
    process.exit(1);
  }

  // Run the sync as a subprocess so we exercise the same code path the
  // orchestrator uses in production.
  console.error(`[smoke-test] running ${connector.source} sync against workspace ${flags.workspaceId}…`);
  const child = spawnSync('bunx', [
    'tsx', path.join(process.cwd(), 'scripts', 'sync-mcp.ts'),
    connector.source, '--from-stdin', `--workspace=${flags.workspaceId}`, '--verbose',
  ], { input: fixture, encoding: 'utf-8' });

  if (child.status !== 0) {
    console.error('[smoke-test] sync subprocess failed', child.stderr);
    process.exit(child.status ?? 1);
  }

  // Parse the trailing JSON result block.
  const out = child.stdout.trim();
  const lastClose = out.lastIndexOf('}');
  const lastOpen = out.lastIndexOf('{', lastClose);
  const candidate = lastOpen >= 0 && lastClose > lastOpen ? out.slice(lastOpen, lastClose + 1) : out;
  let result: any = null;
  try { result = JSON.parse(candidate); } catch { /* ignore */ }

  // Inspect what was newly inserted
  const newItems = newItemsSince(connector.source, beforeItems);
  console.error(`[smoke-test] sync result: ${result?.itemsSynced ?? '?'} synced, ${result?.itemsUpdated ?? '?'} updated`);
  console.error(`[smoke-test] new rows: ${newItems.length} items`);

  // Auto-cleanup unless --keep
  if (flags.keep) {
    console.error('[smoke-test] --keep set; leaving rows in place');
  } else {
    const removed = cleanup(connector.source, beforeItems, beforeLinks);
    console.error(`[smoke-test] cleanup: items=${removed.items} links=${removed.links} versions=${removed.versions}`);
  }

  // Stdout = structured report for assertions
  console.log(JSON.stringify({
    connector: connector.source,
    workspaceId: flags.workspaceId,
    syncResult: result,
    newItems: newItems.map((i) => ({ source_id: i.source_id })),
    kept: flags.keep,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[smoke-test] failed: ${err?.message || err}`);
  process.exit(1);
});
