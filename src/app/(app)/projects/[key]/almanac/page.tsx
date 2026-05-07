/**
 * /projects/<key>/almanac
 *
 * Default behaviour: open the latest completed doc. If no doc is complete
 * yet, open the most recent doc so the user can track it. If the project
 * has no docs at all, show the empty list/generate flow.
 *
 * The list-style catalog is still reachable via ?all=1 for explicit
 * version browsing.
 */

import { redirect } from 'next/navigation';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { AlmanacListClient } from './almanac-list-client';
import { WorkspaceModuleGuard } from '@/components/workspace/workspace-module-guard';

export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
}

export default async function AlmanacIndexPage(props: {
  params: Promise<{ key: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.params;
  const search = (await props.searchParams) ?? {};
  const projectKey = params.key.toUpperCase();
  const showAll = search.all === '1';

  await ensureSchemaAsync();

  if (!showAll) {
    const db = getLibsqlDb();
    // Pick the latest completed doc; otherwise fall back to the most
    // recently created doc so the user can track in-progress generation.
    const latest = await db
      .prepare(
        `SELECT id
         FROM almanac_docs
         WHERE project_key = ?
         ORDER BY
           CASE WHEN status = 'complete' THEN 0 ELSE 1 END,
           COALESCE(completed_at, created_at) DESC
         LIMIT 1`,
      )
      .get<DocRow>(projectKey);

    if (latest) {
      redirect(`/projects/${params.key.toLowerCase()}/almanac/${latest.id}`);
    }
  }

  return (
    <WorkspaceModuleGuard module="projects">
      <AlmanacListClient projectKey={projectKey} />
    </WorkspaceModuleGuard>
  );
}
