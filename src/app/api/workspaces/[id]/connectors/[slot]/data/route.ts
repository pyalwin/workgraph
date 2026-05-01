import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getConnectorConfig } from '@/lib/connectors/config-store';
import { cleanupSourceData, getSourceDataStats } from '@/lib/sync/cleanup';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; slot: string }> },
) {
  try {
    initSchema();
    const { id: workspaceId, slot } = await params;
    const decodedSlot = decodeURIComponent(slot);
    const cfg = getConnectorConfig(workspaceId, decodedSlot);
    if (!cfg) return NextResponse.json({ ok: false, error: 'Unknown connector' }, { status: 404 });
    const stats = getSourceDataStats(cfg.source, workspaceId);
    return NextResponse.json({ ok: true, stats });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; slot: string }> },
) {
  try {
    initSchema();
    const { id: workspaceId, slot } = await params;
    const decodedSlot = decodeURIComponent(slot);
    const cfg = getConnectorConfig(workspaceId, decodedSlot);
    if (!cfg) return NextResponse.json({ ok: false, error: 'Unknown connector' }, { status: 404 });
    const result = cleanupSourceData(cfg.source);
    return NextResponse.json({ ok: true, result });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
