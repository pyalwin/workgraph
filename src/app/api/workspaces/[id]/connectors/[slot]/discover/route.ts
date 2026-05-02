import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getConnectorConfig, upsertConnectorConfig } from '@/lib/connectors/config-store';
import { getConnector } from '@/lib/connectors/registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/workspaces/:id/connectors/:slot/discover?list=projects
 *
 * Calls the adapter's discover() through the live MCP connection, persists
 * the result into config.options.discovered.<list>, and returns the list.
 *
 * Body: optional { listName: string } — defaults to first supportedLists entry.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; slot: string }> },
) {
  try {
    await ensureSchemaAsync();
    const { id: workspaceId, slot } = await params;
    const decodedSlot = decodeURIComponent(slot);
    const url = new URL(req.url);
    const listFromQuery = url.searchParams.get('list');
    const body = await req.json().catch(() => ({}));
    const listName = body.listName || listFromQuery;

    const cfg = await getConnectorConfig(workspaceId, decodedSlot);
    if (!cfg) {
      return NextResponse.json({ ok: false, error: 'Unknown connector' }, { status: 404 });
    }

    const connector = getConnector(cfg.source);
    if (!connector.discover || !connector.supportedLists) {
      return NextResponse.json({ ok: false, error: `${connector.label} doesn't support discovery` }, { status: 400 });
    }

    const target = listName || connector.supportedLists[0]?.id;
    if (!target) return NextResponse.json({ ok: false, error: 'No list specified' }, { status: 400 });

    const supported = connector.supportedLists.find((s) => s.id === target);
    if (!supported) {
      return NextResponse.json({ ok: false, error: `Unknown list "${target}"` }, { status: 400 });
    }

    const { connectMCP, resolveServerConfig } = await import('@/lib/connectors/mcp-client');
    const server = await resolveServerConfig(cfg.serverId, cfg.source, workspaceId, process.env);
    if (!server) {
      return NextResponse.json({ ok: false, error: 'Could not resolve server config — OAuth token missing or env vars not set.' }, { status: 500 });
    }
    const client = await connectMCP(server);

    let discovered;
    try {
      // Pass saved options so adapters that need user-provided context
      // (e.g. github needs username + orgs to enumerate repos) can read them.
      discovered = await connector.discover(
        client,
        target,
        process.env,
        cfg.config.options ?? {},
      );
    } finally {
      await client.close();
    }

    // Persist into config.options.discovered.<listName> so the UI doesn't
    // re-fetch on every panel open.
    const nextOptions = { ...(cfg.config.options || {}) };
    const discoveredMap = (nextOptions.discovered as Record<string, unknown>) || {};
    discoveredMap[target] = discovered;
    nextOptions.discovered = discoveredMap;

    await upsertConnectorConfig({
      workspaceId,
      slot: cfg.slot,
      source: cfg.source,
      serverId: cfg.serverId,
      transport: cfg.transport,
      config: { ...cfg.config, options: nextOptions },
      status: 'configured',
    });

    return NextResponse.json({
      ok: true,
      listName: target,
      label: supported.label,
      mapsToOption: supported.mapsToOption,
      options: discovered,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
