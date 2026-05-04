/**
 * Almanac · agent device-code pair confirmation page.
 *
 * The agent CLI prints a verification URL like:
 *   http://localhost:3000/agent/pair?code=ABCD1234
 *
 * This page reads ?code=…, asks the user to confirm, and POSTs to
 * /api/agent/pair/confirm under their session. After confirmation the
 * agent's poll loop sees status='confirmed' and writes the token to
 * ~/.workgraph/agent.json.
 */
import { PairConfirmClient } from './pair-confirm-client';

export const dynamic = 'force-dynamic';

export default async function AgentPairPage(props: {
  searchParams: Promise<{ code?: string }>;
}) {
  const sp = await props.searchParams;
  const code = (sp.code ?? '').trim().toUpperCase();
  return <PairConfirmClient code={code} />;
}
