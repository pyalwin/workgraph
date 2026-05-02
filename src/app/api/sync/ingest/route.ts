import { NextResponse } from 'next/server';
import { ingestItems } from '@/lib/sync/ingest';
import { startSyncLog, completeSyncLog, failSyncLog } from '@/lib/sync/log';
import type { WorkItemInput } from '@/lib/sync/types';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const items: WorkItemInput[] = body.items;
    const source = body.source || items[0]?.source || 'unknown';

    const logId = await startSyncLog(source);

    try {
      const result = await ingestItems(items);
      await completeSyncLog(logId, result.itemsSynced + result.itemsUpdated);
      return NextResponse.json(result);
    } catch (err: any) {
      await failSyncLog(logId, err.message);
      throw err;
    }
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
