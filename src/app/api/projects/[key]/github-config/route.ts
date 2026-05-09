import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { listGithubReposForWorkspace } from '@/lib/almanac/project-github-config';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import {
  attachProjectConnector,
  listProjectConnectors,
  type ProjectConnector,
} from '@/lib/project-connectors';

/**
 * Thin compat wrapper around the generic project_connectors store. Reads and
 * writes are routed to the unified table (kind='github') while preserving the
 * older response shape so existing UI keeps working. New clients should use
 * /api/projects/[key]/connectors directly.
 */

export const dynamic = 'force-dynamic';

interface ConfigBody {
  repo?: unknown;
  defaultBranch?: unknown;
  pathPrefixes?: unknown;
  ticketPrefixes?: unknown;
  enabled?: unknown;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

interface LegacyGithubConfig {
  id: string;
  workspaceId: string;
  projectKey: string;
  repo: string;
  defaultBranch: string;
  pathPrefixes: string[];
  ticketPrefixes: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function connectorToLegacy(c: ProjectConnector): LegacyGithubConfig {
  const cfg = c.config;
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    projectKey: c.projectKey,
    repo: c.ref,
    defaultBranch: typeof cfg.defaultBranch === 'string' ? cfg.defaultBranch : 'main',
    pathPrefixes: Array.isArray(cfg.pathPrefixes)
      ? cfg.pathPrefixes.filter((v): v is string => typeof v === 'string')
      : [],
    ticketPrefixes: Array.isArray(cfg.ticketPrefixes)
      ? cfg.ticketPrefixes.filter((v): v is string => typeof v === 'string')
      : [],
    enabled: cfg.enabled === false ? false : true,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function GET(_req: Request, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const [allConnectors, availableRepos] = await Promise.all([
    listProjectConnectors(workspaceId, projectKey),
    listGithubReposForWorkspace(workspaceId),
  ]);

  const configs = allConnectors.filter((c) => c.kind === 'github').map(connectorToLegacy);

  return NextResponse.json({
    projectKey,
    configs,
    active: configs.find((c) => c.enabled) ?? null,
    availableRepos,
  });
}

export async function PUT(req: Request, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: ConfigBody;
  try {
    body = (await req.json()) as ConfigBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (typeof body.repo !== 'string' || !body.repo.trim()) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }

  const params = await props.params;
  try {
    const projectKey = params.key.toUpperCase();
    const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
    const connector = await attachProjectConnector({
      workspaceId,
      projectKey,
      kind: 'github',
      ref: body.repo.trim(),
      config: {
        defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : 'main',
        pathPrefixes: parseStringList(body.pathPrefixes),
        ticketPrefixes: parseStringList(body.ticketPrefixes),
        enabled: body.enabled !== false,
      },
    });
    return NextResponse.json({ ok: true, config: connectorToLegacy(connector) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
