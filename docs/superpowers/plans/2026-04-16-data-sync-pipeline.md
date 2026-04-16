# Data Sync Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a data ingestion pipeline that pulls work items from Jira, Slack, Meetings, Notion, and Gmail into WorkGraph's SQLite database, with versioning on conflict and support for scheduled daily execution via Claude Code agents.

**Architecture:** Each source has a dedicated adapter script (`scripts/sync-<source>.ts`) that reads JSON from stdin, maps it to the `work_items` schema, and upserts with versioning. A processing script runs classification, cross-referencing, and metrics after ingestion. The Claude Code scheduled agent orchestrates: fetch via MCP tools → pipe to adapter scripts → run processing.

**Tech Stack:** TypeScript, better-sqlite3, bun, uuid

**Spec:** `docs/superpowers/specs/2026-04-16-data-sync-pipeline-design.md`

---

## File Structure

```
src/lib/sync/
├── types.ts              -- WorkItemInput, SyncResult interfaces
├── versioning.ts         -- diff, snapshot, upsert-with-versioning logic
├── ingest.ts             -- bulk ingest function (accepts WorkItemInput[], upserts)
└── process.ts            -- Phase 3: classify + crossref + metrics

scripts/
├── sync-jira.ts          -- reads Jira JSON from stdin, calls ingest
├── sync-slack.ts         -- reads Slack JSON from stdin, calls ingest
├── sync-meetings.ts      -- reads Meetings JSON from stdin + data/meetings.json, calls ingest
├── sync-notion.ts        -- reads Notion JSON from stdin, calls ingest
├── sync-gmail.ts         -- reads Gmail JSON from stdin, calls ingest
├── process.ts            -- runs Phase 3 processing
└── init-db.ts            -- initializes schema + seeds goals

src/lib/schema.ts         -- (modify) add work_item_versions table
src/lib/crossref.ts       -- (modify) add createLinksForAll() function
```

---

### Task 1: Schema Update — Add `work_item_versions` Table

**Files:**
- Modify: `src/lib/schema.ts:6-106`

- [ ] **Step 1: Add `work_item_versions` table to `initSchema()`**

Add after the `sync_log` table definition (line 95), before the index section:

```typescript
    CREATE TABLE IF NOT EXISTS work_item_versions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES work_items(id),
      changed_fields TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
```

- [ ] **Step 2: Add indexes for `work_item_versions`**

Add after the existing index definitions (line 105):

```typescript
    CREATE INDEX IF NOT EXISTS idx_versions_item ON work_item_versions(item_id);
    CREATE INDEX IF NOT EXISTS idx_versions_changed ON work_item_versions(changed_at);
```

- [ ] **Step 3: Verify schema initializes**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun -e "const {initSchema,seedGoals} = require('./src/lib/schema'); initSchema(); seedGoals(); console.log('Schema initialized')"`

If this errors due to module resolution, use:
```bash
bun --bun -e "import {initSchema,seedGoals} from './src/lib/schema'; initSchema(); seedGoals(); console.log('Schema initialized')"
```

Expected: `Schema initialized` printed, `workgraph.db` file at `/Users/ottimate/Documents/Tracker/workgraph.db` grows from 0 bytes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/schema.ts
git commit -m "feat: add work_item_versions table for change tracking"
```

---

### Task 2: Sync Types

**Files:**
- Create: `src/lib/sync/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
export interface WorkItemInput {
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  author: string | null;
  status: string | null;
  priority: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

export interface SyncResult {
  source: string;
  itemsSynced: number;
  itemsUpdated: number;
  itemsSkipped: number;
  errors: string[];
}

export interface VersionRecord {
  id: string;
  item_id: string;
  changed_fields: string;
  snapshot: string;
  changed_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/types.ts
git commit -m "feat: add sync type definitions"
```

---

### Task 3: Versioning Module

**Files:**
- Create: `src/lib/sync/versioning.ts`

- [ ] **Step 1: Create the versioning module**

```typescript
import { getDb } from '../db';
import { v4 as uuid } from 'uuid';

const TRACKED_FIELDS = ['title', 'body', 'status', 'priority', 'author', 'url', 'metadata'] as const;

interface ExistingItem {
  id: string;
  title: string;
  body: string | null;
  status: string | null;
  priority: string | null;
  author: string | null;
  url: string | null;
  metadata: string | null;
}

export function diffFields(
  existing: ExistingItem,
  incoming: { title: string; body: string | null; status: string | null; priority: string | null; author: string | null; url: string | null; metadata: string | null }
): Record<string, { old: string | null; new: string | null }> | null {
  const changes: Record<string, { old: string | null; new: string | null }> = {};

  for (const field of TRACKED_FIELDS) {
    const oldVal = existing[field] ?? null;
    const newVal = incoming[field] ?? null;
    if (oldVal !== newVal) {
      changes[field] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

export function createVersionRecord(itemId: string, changes: Record<string, { old: string | null; new: string | null }>, existing: ExistingItem): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO work_item_versions (id, item_id, changed_fields, snapshot, changed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(
    uuid(),
    itemId,
    JSON.stringify(changes),
    JSON.stringify(existing)
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/versioning.ts
git commit -m "feat: add versioning module for tracking work item changes"
```

---

### Task 4: Ingest Module

**Files:**
- Create: `src/lib/sync/ingest.ts`

- [ ] **Step 1: Create the ingest module**

```typescript
import { getDb } from '../db';
import { initSchema, seedGoals } from '../schema';
import { v4 as uuid } from 'uuid';
import { diffFields, createVersionRecord } from './versioning';
import type { WorkItemInput, SyncResult } from './types';

export function ingestItems(items: WorkItemInput[]): SyncResult {
  const db = getDb();
  initSchema();
  seedGoals();

  const result: SyncResult = {
    source: items[0]?.source || 'unknown',
    itemsSynced: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    errors: [],
  };

  const findExisting = db.prepare('SELECT id, title, body, status, priority, author, url, metadata FROM work_items WHERE source = ? AND source_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO work_items (id, source, source_id, item_type, title, body, author, status, priority, url, metadata, created_at, updated_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const updateItem = db.prepare(`
    UPDATE work_items SET title = ?, body = ?, author = ?, status = ?, priority = ?, url = ?, metadata = ?, updated_at = ?, synced_at = datetime('now')
    WHERE source = ? AND source_id = ?
  `);
  const touchItem = db.prepare("UPDATE work_items SET synced_at = datetime('now') WHERE source = ? AND source_id = ?");

  const ingestAll = db.transaction(() => {
    for (const item of items) {
      try {
        const existing = findExisting.get(item.source, item.source_id) as any;
        const metadataStr = item.metadata ? JSON.stringify(item.metadata) : null;

        if (!existing) {
          insertItem.run(uuid(), item.source, item.source_id, item.item_type, item.title, item.body, item.author, item.status, item.priority, item.url, metadataStr, item.created_at, item.updated_at);
          result.itemsSynced++;
        } else {
          const incoming = { title: item.title, body: item.body, status: item.status, priority: item.priority, author: item.author, url: item.url, metadata: metadataStr };
          const changes = diffFields(existing, incoming);

          if (changes) {
            createVersionRecord(existing.id, changes, existing);
            updateItem.run(item.title, item.body, item.author, item.status, item.priority, item.url, metadataStr, item.updated_at, item.source, item.source_id);
            result.itemsUpdated++;
          } else {
            touchItem.run(item.source, item.source_id);
            result.itemsSkipped++;
          }
        }
      } catch (err: any) {
        result.errors.push(`${item.source_id}: ${err.message}`);
      }
    }
  });

  ingestAll();
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/ingest.ts
git commit -m "feat: add ingest module with upsert and versioning"
```

---

### Task 5: Update Cross-Reference Module

**Files:**
- Modify: `src/lib/crossref.ts:45`

- [ ] **Step 1: Add `createLinksForAll()` function**

Append to the end of `src/lib/crossref.ts`:

```typescript
export function createLinksForAll() {
  const db = getDb();
  const items = db.prepare('SELECT id FROM work_items').all() as { id: string }[];
  for (const item of items) {
    createLinksForItem(item.id);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/crossref.ts
git commit -m "feat: add createLinksForAll to cross-reference module"
```

---

### Task 6: Processing Script

**Files:**
- Create: `scripts/process.ts`

- [ ] **Step 1: Create the processing script**

This script runs Phase 3: classify → cross-reference → metrics.

```typescript
import { initSchema, seedGoals } from '../src/lib/schema';
import { reclassifyAll } from '../src/lib/classify';
import { createLinksForAll } from '../src/lib/crossref';
import { computeAllMetrics } from '../src/lib/metrics';

initSchema();
seedGoals();

console.log('Phase 3: Processing...');

console.log('  Classifying items to goals...');
reclassifyAll();

console.log('  Creating cross-reference links...');
createLinksForAll();

console.log('  Computing metrics snapshots...');
computeAllMetrics();

console.log('Processing complete.');
```

- [ ] **Step 2: Test it runs**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/process.ts`

Expected: Prints all three steps and "Processing complete." (no data to process yet, but no errors).

- [ ] **Step 3: Commit**

```bash
git add scripts/process.ts
git commit -m "feat: add Phase 3 processing script"
```

---

### Task 7: DB Init Script

**Files:**
- Create: `scripts/init-db.ts`

- [ ] **Step 1: Create the init script**

```typescript
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
```

- [ ] **Step 2: Run it**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/init-db.ts`

Expected: Lists all tables and 6 seeded goals.

- [ ] **Step 3: Commit**

```bash
git add scripts/init-db.ts
git commit -m "feat: add database initialization script"
```

---

### Task 8: Jira Adapter Script

**Files:**
- Create: `scripts/sync-jira.ts`

- [ ] **Step 1: Create the Jira adapter**

Reads JSON array of Jira issues from stdin, maps to `WorkItemInput`, calls `ingestItems`.

```typescript
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const issues = JSON.parse(raw);

  const items: WorkItemInput[] = issues.map((issue: any) => ({
    source: 'jira',
    source_id: issue.key,
    item_type: issue.fields?.issuetype?.name?.toLowerCase() || 'task',
    title: issue.fields?.summary || issue.key,
    body: issue.fields?.description || null,
    author: issue.fields?.assignee?.displayName || issue.fields?.reporter?.displayName || null,
    status: issue.fields?.status?.name?.toLowerCase().replace(/\s+/g, '_') || null,
    priority: issue.fields?.priority?.name?.toLowerCase() || null,
    url: `https://${issue.self?.split('/rest/')[0]?.split('//')[1] || 'jira'}/browse/${issue.key}`,
    metadata: {
      labels: issue.fields?.labels || [],
      components: issue.fields?.components?.map((c: any) => c.name) || [],
      sprint: issue.fields?.sprint?.name || null,
      reporter: issue.fields?.reporter?.displayName || null,
      project: issue.fields?.project?.key || null,
      resolution: issue.fields?.resolution?.name || null,
    },
    created_at: issue.fields?.created || new Date().toISOString(),
    updated_at: issue.fields?.updated || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Jira sync failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync-jira.ts
git commit -m "feat: add Jira adapter script"
```

---

### Task 9: Slack Adapter Script

**Files:**
- Create: `scripts/sync-slack.ts`

- [ ] **Step 1: Create the Slack adapter**

Reads JSON array of Slack messages from stdin, maps to `WorkItemInput`, calls `ingestItems`.

```typescript
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const messages = JSON.parse(raw);

  const items: WorkItemInput[] = messages.map((msg: any) => ({
    source: 'slack',
    source_id: `${msg.channel_id || msg.channel}:${msg.ts}`,
    item_type: msg.thread_ts && msg.thread_ts !== msg.ts ? 'thread_reply' : msg.thread_ts ? 'thread' : 'message',
    title: (msg.text || '').slice(0, 200),
    body: msg.text || null,
    author: msg.user_name || msg.user || null,
    status: 'posted',
    priority: null,
    url: msg.permalink || null,
    metadata: {
      channel_name: msg.channel_name || msg.channel || null,
      channel_id: msg.channel_id || null,
      thread_ts: msg.thread_ts || null,
      reply_count: msg.reply_count || 0,
      reaction_count: msg.reactions?.length || 0,
    },
    created_at: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : new Date().toISOString(),
    updated_at: msg.edited?.ts ? new Date(parseFloat(msg.edited.ts) * 1000).toISOString() : null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Slack sync failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync-slack.ts
git commit -m "feat: add Slack adapter script"
```

---

### Task 10: Meetings Adapter Script

**Files:**
- Create: `scripts/sync-meetings.ts`

- [ ] **Step 1: Create the Meetings adapter**

Reads Granola meetings from stdin AND ingests `data/meetings.json` on first run.

```typescript
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '[]';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function mapGranolaMeeting(meeting: any): WorkItemInput {
  return {
    source: 'meeting',
    source_id: meeting.id,
    item_type: 'meeting',
    title: meeting.title || 'Untitled Meeting',
    body: meeting.transcript || meeting.summary || meeting.notes || null,
    author: meeting.participants?.[0] || meeting.organizer || null,
    status: 'completed',
    priority: null,
    url: meeting.url || null,
    metadata: {
      participants: meeting.participants || [],
      duration: meeting.duration || null,
      folder: meeting.folder || null,
    },
    created_at: meeting.date ? new Date(meeting.date).toISOString() : new Date().toISOString(),
    updated_at: null,
  };
}

function mapJsonMeeting(meeting: any): WorkItemInput {
  return {
    source: 'meeting',
    source_id: meeting.id,
    item_type: 'meeting',
    title: meeting.title || 'Untitled Meeting',
    body: meeting.summary || null,
    author: meeting.participants?.[0] || null,
    status: 'completed',
    priority: null,
    url: meeting.url || null,
    metadata: {
      participants: meeting.participants || [],
    },
    created_at: meeting.date ? new Date(meeting.date).toISOString() : new Date().toISOString(),
    updated_at: null,
  };
}

async function main() {
  const allItems: WorkItemInput[] = [];

  // Ingest from stdin (Granola MCP data)
  const raw = await readStdin();
  const granulaMeetings = JSON.parse(raw);
  allItems.push(...granulaMeetings.map(mapGranolaMeeting));

  // Ingest from data/meetings.json (first run / catch-up)
  const jsonPath = path.join(process.cwd(), 'data', 'meetings.json');
  if (existsSync(jsonPath)) {
    const jsonMeetings = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    allItems.push(...jsonMeetings.map(mapJsonMeeting));
  }

  if (allItems.length === 0) {
    console.log(JSON.stringify({ source: 'meeting', itemsSynced: 0, itemsUpdated: 0, itemsSkipped: 0, errors: [] }));
    return;
  }

  const result = ingestItems(allItems);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Meetings sync failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Test with existing meetings.json**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && echo '[]' | bun scripts/sync-meetings.ts`

Expected: JSON output showing ~100 items synced from `data/meetings.json`.

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-meetings.ts
git commit -m "feat: add Meetings adapter script with meetings.json ingestion"
```

---

### Task 11: Notion Adapter Script

**Files:**
- Create: `scripts/sync-notion.ts`

- [ ] **Step 1: Create the Notion adapter**

```typescript
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const pages = JSON.parse(raw);

  const items: WorkItemInput[] = pages.map((page: any) => ({
    source: 'notion',
    source_id: page.id,
    item_type: page.object === 'database' ? 'database' : 'page',
    title: page.title || page.properties?.Name?.title?.[0]?.plain_text || page.properties?.title?.title?.[0]?.plain_text || 'Untitled',
    body: page.content || page.description || null,
    author: page.last_edited_by?.name || page.created_by?.name || null,
    status: 'published',
    priority: null,
    url: page.url || null,
    metadata: {
      parent_database: page.parent?.database_id || null,
      last_edited_time: page.last_edited_time || null,
      properties: page.properties ? Object.keys(page.properties) : [],
    },
    created_at: page.created_time || new Date().toISOString(),
    updated_at: page.last_edited_time || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Notion sync failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync-notion.ts
git commit -m "feat: add Notion adapter script"
```

---

### Task 12: Gmail Adapter Script

**Files:**
- Create: `scripts/sync-gmail.ts`

- [ ] **Step 1: Create the Gmail adapter**

```typescript
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const threads = JSON.parse(raw);

  const items: WorkItemInput[] = threads.map((thread: any) => ({
    source: 'gmail',
    source_id: thread.id || thread.threadId,
    item_type: 'email_thread',
    title: thread.subject || thread.snippet?.slice(0, 120) || 'No subject',
    body: thread.snippet || thread.body || null,
    author: thread.from || thread.sender || null,
    status: thread.labelIds?.includes('SENT') ? 'sent' : 'received',
    priority: thread.labelIds?.includes('IMPORTANT') ? 'high' : null,
    url: thread.threadId ? `https://mail.google.com/mail/u/0/#inbox/${thread.threadId}` : null,
    metadata: {
      labels: thread.labelIds || [],
      message_count: thread.messagesCount || thread.messages?.length || 1,
      participants: thread.participants || [],
      to: thread.to || null,
    },
    created_at: thread.date || thread.internalDate ? new Date(parseInt(thread.internalDate)).toISOString() : new Date().toISOString(),
    updated_at: thread.lastMessageDate || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Gmail sync failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync-gmail.ts
git commit -m "feat: add Gmail adapter script"
```

---

### Task 13: Sync Log Helpers

**Files:**
- Create: `src/lib/sync/log.ts`

- [ ] **Step 1: Create sync log helpers**

These are used by the Claude agent to record sync runs and look up watermarks.

```typescript
import { getDb } from '../db';
import { v4 as uuid } from 'uuid';

export function getLastSyncDate(source: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1"
  ).get(source) as { completed_at: string } | undefined;
  return row?.completed_at || null;
}

export function startSyncLog(source: string): string {
  const db = getDb();
  const id = uuid();
  db.prepare(
    "INSERT INTO sync_log (id, source, started_at, status) VALUES (?, ?, datetime('now'), 'running')"
  ).run(id, source);
  return id;
}

export function completeSyncLog(logId: string, itemsSynced: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE sync_log SET completed_at = datetime('now'), items_synced = ?, status = 'success' WHERE id = ?"
  ).run(itemsSynced, logId);
}

export function failSyncLog(logId: string, error: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE sync_log SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?"
  ).run(error, logId);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/log.ts
git commit -m "feat: add sync log helpers for watermark tracking"
```

---

### Task 14: Sync Status Script

**Files:**
- Create: `scripts/sync-status.ts`

- [ ] **Step 1: Create status script**

The Claude agent runs this to check watermarks before deciding what to fetch.

```typescript
import { initSchema } from '../src/lib/schema';
import { getDb } from '../src/lib/db';
import { getLastSyncDate } from '../src/lib/sync/log';

initSchema();

const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
const db = getDb();

console.log('=== Sync Status ===');
for (const source of sources) {
  const lastSync = getLastSyncDate(source);
  const count = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(source) as any)?.c || 0;
  console.log(`${source}: ${count} items, last sync: ${lastSync || 'never'}`);
}

const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
const totalVersions = (db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get() as any)?.c || 0;
const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;
console.log(`\nTotals: ${totalItems} items, ${totalVersions} versions, ${totalLinks} cross-references`);
```

- [ ] **Step 2: Test it**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/sync-status.ts`

Expected: Shows 0 items for all sources (or meeting items if Task 10 was tested).

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-status.ts
git commit -m "feat: add sync status script for watermark inspection"
```

---

### Task 15: Update Sync API Route

**Files:**
- Modify: `src/app/api/sync/route.ts`

- [ ] **Step 1: Update the sync route to use the new processing pipeline**

Replace the entire file:

```typescript
import { NextResponse } from 'next/server';
import { initSchema, seedGoals } from '@/lib/schema';
import { computeAllMetrics } from '@/lib/metrics';
import { reclassifyAll } from '@/lib/classify';
import { createLinksForAll } from '@/lib/crossref';
import { getDb } from '@/lib/db';

export async function POST() {
  try {
    initSchema();
    seedGoals();
    reclassifyAll();
    createLinksForAll();
    computeAllMetrics();

    const db = getDb();
    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    return NextResponse.json({ ok: true, message: 'Processing complete', totalItems, totalLinks });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    initSchema();
    const db = getDb();
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const status: Record<string, any> = {};

    for (const source of sources) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(source) as any)?.c || 0;
      const lastSync = db.prepare("SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1").get(source) as any;
      status[source] = { count, lastSync: lastSync?.completed_at || null };
    }

    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalVersions = (db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    return NextResponse.json({ totalItems, totalVersions, totalLinks, sources: status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sync/route.ts
git commit -m "feat: update sync route with processing pipeline and status endpoint"
```

---

### Task 16: Ingest API Route

**Files:**
- Create: `src/app/api/sync/ingest/route.ts`

- [ ] **Step 1: Create the ingest API route**

Alternative ingestion path — the agent can POST items directly instead of using stdin scripts.

```typescript
import { NextResponse } from 'next/server';
import { ingestItems } from '@/lib/sync/ingest';
import { startSyncLog, completeSyncLog, failSyncLog } from '@/lib/sync/log';
import type { WorkItemInput } from '@/lib/sync/types';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const items: WorkItemInput[] = body.items;
    const source = body.source || items[0]?.source || 'unknown';

    const logId = startSyncLog(source);

    try {
      const result = ingestItems(items);
      completeSyncLog(logId, result.itemsSynced + result.itemsUpdated);
      return NextResponse.json(result);
    } catch (err: any) {
      failSyncLog(logId, err.message);
      throw err;
    }
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sync/ingest/route.ts
git commit -m "feat: add ingest API route for direct item ingestion"
```

---

### Task 17: End-to-End Test — Initialize and Ingest Meetings

- [ ] **Step 1: Initialize the database**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/init-db.ts`

Expected: Schema created, 6 goals seeded.

- [ ] **Step 2: Ingest meetings.json**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && echo '[]' | bun scripts/sync-meetings.ts`

Expected: ~100 items synced from `data/meetings.json`.

- [ ] **Step 3: Run processing**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/process.ts`

Expected: Classification, cross-referencing, and metrics computed.

- [ ] **Step 4: Check status**

Run: `cd /Users/ottimate/Documents/Tracker/workgraph && bun scripts/sync-status.ts`

Expected: Shows ~100 meeting items, cross-references if any Jira keys found in meeting titles.

- [ ] **Step 5: Verify dashboard reads from DB**

Open `http://localhost:3000` and confirm the dashboard shows real data from the database instead of hardcoded fallback values.

---

### Task 18: Scheduled Agent Setup

- [ ] **Step 1: Create the scheduled agent using `/schedule`**

The agent prompt should instruct Claude to:

1. Run `bun scripts/sync-status.ts` to check watermarks
2. **Phase 1 (parallel):**
   - Fetch Jira issues using `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` for projects Integrations, PEX, OA since last sync (or Jan 1 2026 on first run). Pipe results to `bun scripts/sync-jira.ts`
   - Fetch Slack messages using `mcp__plugin_slack_slack__slack_search_public_and_private` from all channels since last sync. Pipe results to `bun scripts/sync-slack.ts`
   - Fetch meetings using `mcp__claude_ai_Granola__list_meetings` since last sync. Pipe results to `bun scripts/sync-meetings.ts`
3. **Phase 2:**
   - Fetch Notion pages using `mcp__claude_ai_Notion__notion-search`. Pipe results to `bun scripts/sync-notion.ts`
   - Fetch Gmail threads using `mcp__claude_ai_Gmail__search_threads` since last sync. Pipe results to `bun scripts/sync-gmail.ts`
4. Run `bun scripts/process.ts` for Phase 3
5. Run `bun scripts/sync-status.ts` to report final counts

- [ ] **Step 2: Test the agent prompt manually**

Before scheduling, execute the agent prompt once manually to verify the full pipeline works end-to-end.

- [ ] **Step 3: Schedule daily execution**

Use the `/schedule` command to set up daily morning execution.
