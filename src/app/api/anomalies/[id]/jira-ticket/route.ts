/**
 * Convert an open anomaly into a real Jira issue via the workspace's
 * Atlassian MCP connector. The user is expected to have edited the
 * pre-filled summary + description before submitting (the form is the
 * "verification" the user asked for — we don't auto-create tickets).
 *
 * Body: {
 *   summary: string;
 *   description: string;
 *   project_key: string;          // e.g. 'ALPHA' — Jira project key, not slug
 *   issue_type?: string;          // default 'Task'
 *   priority?: string;            // optional Jira priority name (Highest/High/...)
 *   labels?: string[];
 *   dismiss?: boolean;
 *   handled_note?: string;
 * }
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { loadAnomaly, markAnomalyHandled } from '@/lib/anomaly-actions';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { connectMCP, resolveServerConfig } from '@/lib/connectors/mcp-client';
import { getConnector } from '@/lib/connectors/registry';
import type { MCPClient } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';
// Creating an issue can stall on slow MCP transports — give it a wide window
// rather than letting Vercel's default kill the request mid-flight.
export const maxDuration = 60;

interface Body {
  summary?: unknown;
  description?: unknown;
  project_key?: unknown;
  issue_type?: unknown;
  priority?: unknown;
  labels?: unknown;
  dismiss?: unknown;
  handled_note?: unknown;
}

function resolveCloudId(cfg: { config?: { options?: Record<string, unknown> } }): string {
  const opts = cfg.config?.options ?? {};
  return (opts.cloudId as string)
    || process.env.MCP_ATLASSIAN_CLOUD_ID
    || (opts.jiraUrl as string)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    || 'example.atlassian.net';
}

function resolveBaseUrl(cfg: { config?: { options?: Record<string, unknown> } }): string {
  const opts = cfg.config?.options ?? {};
  return (opts.jiraUrl as string)
    || process.env.MCP_ATLASSIAN_BASE_URL
    || `https://${resolveCloudId(cfg)}`;
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  await ensureSchemaAsync();

  const anomaly = await loadAnomaly(params.id);
  if (!anomaly) {
    return NextResponse.json({ ok: false, error: 'Anomaly not found' }, { status: 404 });
  }
  if (anomaly.handled_at) {
    return NextResponse.json({
      ok: true,
      already_handled: true,
      jira_issue_key: anomaly.jira_issue_key,
      action_item_id: anomaly.action_item_id,
    });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const projectKey = typeof body.project_key === 'string' ? body.project_key.trim().toUpperCase() : '';
  const issueType = typeof body.issue_type === 'string' && body.issue_type.trim() ? body.issue_type.trim() : 'Task';
  const priority = typeof body.priority === 'string' && body.priority.trim() ? body.priority.trim() : null;
  const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
  const labels = labelsRaw.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
  const dismiss = body.dismiss === true;
  const handledNote = typeof body.handled_note === 'string' && body.handled_note.trim()
    ? body.handled_note.trim()
    : null;

  if (!summary) return NextResponse.json({ ok: false, error: 'summary is required' }, { status: 400 });
  if (!projectKey) return NextResponse.json({ ok: false, error: 'project_key is required' }, { status: 400 });

  const cfg = await getConnectorConfigBySource(anomaly.workspace_id, 'jira');
  if (!cfg) {
    return NextResponse.json(
      { ok: false, error: 'No Jira connector configured for this workspace' },
      { status: 400 },
    );
  }

  // Connect MCP. We don't use markSyncStarted/Finished — this is an interactive
  // user request, not a background sync, and we don't want it to clobber the
  // sync status indicator.
  let client: MCPClient | null = null;
  try {
    const connector = getConnector('jira');
    const server = await resolveServerConfig(connector.serverId, 'jira', anomaly.workspace_id, process.env);
    if (!server) {
      return NextResponse.json(
        { ok: false, error: 'Could not resolve MCP server config for jira' },
        { status: 500 },
      );
    }
    client = await connectMCP(server);

    const cloudId = resolveCloudId(cfg);
    const baseUrl = resolveBaseUrl(cfg);

    // The atlassian MCP server's createJiraIssue takes the cloudId, the
    // project key, and the issue type *name* (not id). Description uses ADF
    // when supported but plain text is also accepted by most builds.
    const args: Record<string, unknown> = {
      cloudId,
      projectKey,
      issueTypeName: issueType,
      summary,
      description,
    };
    if (priority) args.priority = priority;
    if (labels.length > 0) args.labels = labels;

    let resp: unknown;
    try {
      resp = await client.callTool('createJiraIssue', args);
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Jira createIssue failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }

    // Server responses vary by MCP build — try a few common shapes before
    // giving up. The key is the only thing we strictly need.
    const respAny = resp as Record<string, unknown> | string | null;
    const newKey = typeof respAny === 'string'
      ? respAny
      : (respAny?.key as string)
        ?? (respAny?.issue as Record<string, unknown> | undefined)?.key as string | undefined
        ?? (respAny?.id as string | undefined);
    if (!newKey || typeof newKey !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Jira responded without a key', raw: resp },
        { status: 502 },
      );
    }

    await markAnomalyHandled(anomaly.id, {
      jira_issue_key: newKey,
      handled_note: handledNote,
      dismiss,
    });

    return NextResponse.json({
      ok: true,
      jira_issue_key: newKey,
      jira_url: `${baseUrl}/browse/${newKey}`,
      project_key: projectKey,
      dismissed: dismiss,
    });
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore — best-effort cleanup
      }
    }
  }
}
