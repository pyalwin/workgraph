import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import {
  getConnectorConfig,
  isSyncRunActive,
  listConnectorConfigs,
  mergeStdioSecrets,
  reapStaleSyncs,
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
    await ensureSchemaAsync();
    // Sweep crashed-running rows on every list call. Cheap (one UPDATE) and
    // keeps the UI from showing stuck-running connectors after a worker
    // restart, OOM, or a lost Inngest event.
    await reapStaleSyncs();
    const { id: workspaceId } = await params;
    const configs = (await listConnectorConfigs(workspaceId)).map((cfg) => {
      // Defensive: row may have escaped the sweep (race with reap).
      // Force-flip status='running' to 'error' if past the active window so
      // the UI never renders a phantom in-flight indicator.
      if (cfg.lastSyncStatus === 'running' && !isSyncRunActive(cfg)) {
        cfg.lastSyncStatus = 'error';
        cfg.lastSyncError = cfg.lastSyncError ?? 'Sync did not finish (worker likely crashed)';
      }
      return redactConfig(cfg);
    });
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
    await ensureSchemaAsync();
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

    // On update, carry over fields the install form doesn't re-send.
    const existing = await getConnectorConfig(workspaceId, slot);
    if (existing && transport === 'stdio') {
      payload.args = mergeStdioSecrets(existing.config.args, payload.args);
    }
    if (existing && transport === 'http' && !payload.token && existing.config.token) {
      payload.token = existing.config.token;
    }
    // Merge options (e.g. `repos` multi-select, `discovered.<list>` cache)
    // rather than replacing — presetFieldsToPayload only emits preset
    // fields (token, username, orgs), so the install body otherwise blows
    // away picker state on every Update click.
    if (existing?.config?.options) {
      payload.options = {
        ...existing.config.options,
        ...(payload.options ?? {}),
      };
    }

    const config = await upsertConnectorConfig({
      workspaceId,
      slot,
      source,
      serverId: adapter.serverId,
      transport,
      config: payload,
      status: 'configured',
    });

    // Kick off the first sync immediately via Inngest. The worker is the
    // sole writer of sync state, so we don't pre-mark started here — that
    // would leave the row stuck at 'running' if the event delivery itself
    // failed. The UI polls the connector row and will see 'running' as soon
    // as the worker enters its run-sync step.
    let syncTriggered = false;
    if (body.runSync !== false) {
      try {
        const { inngest } = await import('@/inngest/client');
        const eventName =
          source === 'jira' ? 'workgraph/jira.sync.workspace' : 'workgraph/connector.sync.workspace';
        await inngest.send({
          name: eventName,
          data: { workspaceId, slot, source, since: null },
        });
        syncTriggered = true;
      } catch {
        // Non-fatal — install succeeded; sync can be retried via /sync.
      }
    }

    return NextResponse.json({ ok: true, config: redactConfig(config), syncTriggered });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
