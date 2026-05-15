import { notFound } from 'next/navigation';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { resolveWorkspaceForTable } from '@/lib/custom-tables';
import { CustomTableList } from '@/components/tables/CustomTableList';

export const dynamic = 'force-dynamic';

export default async function CustomTablePage({
  params,
}: {
  params: Promise<{ table: string }>;
}) {
  await ensureSchemaAsync();
  const { table } = await params;
  const resolved = await resolveWorkspaceForTable(table);
  if (!resolved) notFound();
  return <CustomTableList table={resolved.table} />;
}
