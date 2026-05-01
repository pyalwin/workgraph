import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import {
  getConnectorConfig,
  listConnectorConfigs,
  mergeStdioSecrets,
  redactConfig,
  upsertConnectorConfig,
  type ConnectorConfigPayload,
} from '@/lib/connectors/config-store';
import { connectors } from '@/lib/connectors/registry';
import { optionsForSlot } from '@/lib/connectors/preset-mapping';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initSchema();
    const { id: workspaceId } = await params;
    const configs = listConnectorConfigs(workspaceId).map(redactConfig);
    return NextResponse.json({ ok: true, configs });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initSchema();
    const { id: workspaceId } = await params;
    const body = await req.json();

    const slot = String(body.slot || '').trim();
    const source = String(body.source || '').trim().toLowerCase();
    const transport = body.transport === 'stdio' ? 'stdio' : 'http';

    if (!slot) return NextResponse.json({ ok: false, error: 'slot is required' }, { status: 400 });
    if (!source) return NextResponse.json({ ok: false, error: 'source is required' }, { status: 400 });

    const adapter = connectors[source];
    if (!adapter) {
      return NextResponse.json({ ok: false, error: `Unknown source "${source}"` }, { status: 400 });
    }

    const slotOptions = optionsForSlot(slot);
    if (slotOptions.length > 0 && !slotOptions.some((o) => o.source === source)) {
      return NextResponse.json(
        { ok: false, error: `Source "${source}" is not valid for slot "${slot}"` },
        { status: 400 },
      );
    }

    const payload: ConnectorConfigPayload = {
      url: body.url || undefined,
      token: body.token || undefined,
      command: body.command || undefined,
      args: Array.isArray(body.args) ? body.args : undefined,
      headers: body.headers && typeof body.headers === 'object' ? body.headers : undefined,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
    };

    if (transport === 'http' && !payload.url) {
      return NextResponse.json({ ok: false, error: 'url is required for http transport' }, { status: 400 });
    }
    if (transport === 'stdio' && !payload.command) {
      return NextResponse.json({ ok: false, error: 'command is required for stdio transport' }, { status: 400 });
    }

    // On update, carry over saved secret env entries the user didn't re-enter.
    const existing = getConnectorConfig(workspaceId, slot);
    if (existing && transport === 'stdio') {
      payload.args = mergeStdioSecrets(existing.config.args, payload.args);
    }
    if (existing && transport === 'http' && !payload.token && existing.config.token) {
      payload.token = existing.config.token;
    }

    const config = upsertConnectorConfig({
      workspaceId,
      slot,
      source,
      serverId: adapter.serverId,
      transport,
      config: payload,
      status: 'configured',
    });

    // Kick off the first sync immediately. Runs detached; UI polls for status.
    let syncTriggered = false;
    if (body.runSync !== false) {
      try {
        const { triggerSync } = await import('@/lib/connectors/sync-orchestrator');
        const r = triggerSync(workspaceId, slot, source);
        syncTriggered = r.ok;
      } catch {
        // Non-fatal — install succeeded; sync can be retried via /sync.
      }
    }

    return NextResponse.json({ ok: true, config: redactConfig(config), syncTriggered });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
