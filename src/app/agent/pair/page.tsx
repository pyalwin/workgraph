/**
 * Almanac · agent device-code pair confirmation page.
 *
 * The agent CLI prints a verification URL like:
 *   http://localhost:3000/agent/pair?code=ABCD1234
 *
 * Lives OUTSIDE the (app) route group so it bypasses WorkspaceAppShell
 * (the onboarding wrapper) — pairing must work even before the user
 * has a configured workspace.
 *
 * Auth is enforced by authkitProxy (/agent/pair is not in
 * unauthenticatedPaths) and re-checked here defensively.
 */
import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { PairConfirmClient } from './pair-confirm-client';

export const dynamic = 'force-dynamic';

export default async function AgentPairPage(props: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { user } = await withAuth();
  if (!user) redirect('/sign-in');

  const sp = await props.searchParams;
  const code = (sp.code ?? '').trim().toUpperCase();
  return <PairConfirmClient code={code} />;
}
