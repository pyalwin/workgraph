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
  const granolaMeetings = JSON.parse(raw);
  allItems.push(...granolaMeetings.map(mapGranolaMeeting));

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
