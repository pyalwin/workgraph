import { notFound } from 'next/navigation';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { resolveWorkspaceForTable } from '@/lib/custom-tables';
import { CustomTableDetail } from '@/components/tables/CustomTableDetail';

export const dynamic = 'force-dynamic';

export default async function CustomTableDetailPage({
  params,
}: {
  params: Promise<{ table: string; id: string }>;
}) {
  await ensureSchemaAsync();
  const { table, id } = await params;
  const resolved = await resolveWorkspaceForTable(table);
  if (!resolved) notFound();
  return <CustomTableDetail table={resolved.table} id={id} />;
}
