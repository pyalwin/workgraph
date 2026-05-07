import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import {
  listGithubReposForWorkspace,
  listProjectGithubConfigs,
  upsertProjectGithubConfig,
} from '@/lib/almanac/project-github-config';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';

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

export async function GET(_req: Request, props: { params: Promise<{ key: string }> }) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = await props.params;
  const projectKey = params.key.toUpperCase();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const [configs, availableRepos] = await Promise.all([
    listProjectGithubConfigs(workspaceId, projectKey),
    listGithubReposForWorkspace(workspaceId),
  ]);

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
    const config = await upsertProjectGithubConfig({
      workspaceId: await resolveAlmanacWorkspaceId(params.key),
      projectKey: params.key,
      repo: body.repo,
      defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : undefined,
      pathPrefixes: parseStringList(body.pathPrefixes),
      ticketPrefixes: parseStringList(body.ticketPrefixes),
      enabled: body.enabled !== false,
    });
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
