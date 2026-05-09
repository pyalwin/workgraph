import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import {
  ConnectorRefConflictError,
  PROJECT_KEY_PATTERN,
  attachProjectConnector,
  isConnectorKind,
  listProjectConnectors,
} from '@/lib/project-connectors';
import { createProject, getProject } from '@/lib/project-crud';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

async function registerRepoOnWorkspaceConnector(
  workspaceId: string,
  slot: string,
  repo: string,
): Promise<void> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(`SELECT config FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?`)
    .get<{ config: string }>(workspaceId, slot);
  if (!row) return;

  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch {
    cfg = {};
  }
  const options =
    cfg.options && typeof cfg.options === 'object' && !Array.isArray(cfg.options)
      ? (cfg.options as Record<string, unknown>)
      : {};
  const repos = Array.isArray(options.repos)
    ? (options.repos as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (repos.includes(repo)) return;
  repos.push(repo);
  cfg.options = { ...options, repos };

  await db
    .prepare(
      `UPDATE workspace_connector_configs SET config = ?, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
    )
    .run(JSON.stringify(cfg), new Date().toISOString(), workspaceId, slot);
}

export async function GET(_req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();
  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const connectors = await listProjectConnectors(workspaceId, projectKey);
  return NextResponse.json({ projectKey, workspaceId, connectors });
}

interface AttachBody {
  kind?: unknown;
  ref?: unknown;
  config?: unknown;
}

export async function POST(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: AttachBody;
  try {
    body = (await req.json()) as AttachBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (!isConnectorKind(body.kind)) {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
  }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!ref) {
    return NextResponse.json({ error: 'ref is required' }, { status: 400 });
  }

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    return NextResponse.json(
      { error: 'invalid_key', pattern: PROJECT_KEY_PATTERN.source },
      { status: 400 },
    );
  }

  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  // 422 if the kind's workspace connector isn't configured.
  const wsConn = await getConnectorConfigBySource(workspaceId, body.kind);
  if (!wsConn || wsConn.status !== 'configured') {
    return NextResponse.json(
      { error: 'connector_not_configured', kind: body.kind },
      { status: 422 },
    );
  }

  // Implicit project creation if [key] doesn't exist yet.
  const existing = await getProject(projectKey);
  if (!existing) {
    try {
      await createProject({ key: projectKey, name: projectKey, createdVia: 'connector-attach' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const config =
    body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};

  try {
    const connector = await attachProjectConnector({
      workspaceId,
      projectKey,
      kind: body.kind,
      ref,
      config,
    });

    // For GitHub: also register the repo on the workspace github connector's
    // options.repos so the trails/release sync actually pulls items for it.
    // Without this, attaching a repo to a project records the binding but
    // nothing flows in.
    if (body.kind === 'github') {
      await registerRepoOnWorkspaceConnector(workspaceId, wsConn.slot, ref);
    }

    // Auto-regenerate the project's AI surfaces (README, OKRs, recap,
    // action items, backlog) so the project detail page populates as soon
    // as the binding lands. Best-effort — don't block the API response.
    void Promise.allSettled([
      inngest.send({ name: 'workgraph/project-summary.regen', data: { projectKey, projectName: projectKey } }),
      inngest.send({ name: 'workgraph/project.readme.refresh', data: { projectKey } }),
      inngest.send({ name: 'workgraph/project.okrs.refresh', data: { projectKey } }),
      inngest.send({ name: 'workgraph/project.action-items.refresh', data: { projectKey } }),
      inngest.send({ name: 'workgraph/project.backlog.refresh', data: { projectKey } }),
    ]).catch(() => {
      /* non-fatal — UI shows empty state until next refresh */
    });

    return NextResponse.json({ ok: true, connector }, { status: 201 });
  } catch (err) {
    if (err instanceof ConnectorRefConflictError) {
      return NextResponse.json(
        { error: 'ref_already_bound', conflictingProjectKey: err.conflictingProjectKey },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
