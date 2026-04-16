import { initSchema, seedOttiDeployments, seedOttiUsers } from '@/lib/schema';
import { OttiClient } from './otti-client';

export const dynamic = 'force-dynamic';

export default function OttiPage() {
  initSchema();
  seedOttiDeployments();
  seedOttiUsers();

  return <OttiClient />;
}
