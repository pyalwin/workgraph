import KnowledgeGraphClient from './knowledge-graph-client';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  return (
    <div className="-mt-[52px]">
      <KnowledgeGraphClient />
    </div>
  );
}
