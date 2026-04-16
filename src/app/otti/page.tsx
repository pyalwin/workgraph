import { initSchema, seedOttiDeployments } from '@/lib/schema';
import { OttiClient } from './otti-client';

export const dynamic = 'force-dynamic';

export default function OttiPage() {
  initSchema();
  seedOttiDeployments();

  return <OttiClient />;
}
