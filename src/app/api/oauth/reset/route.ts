import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/oauth/reset?source=jira[&tokens=true]
 *
 * Clears cached DCR client + any in-flight state for a provider so the next
 * /start re-runs Dynamic Client Registration. Pass tokens=true to ALSO wipe
 * the encrypted access/refresh tokens — needed when an issued token has a
 * stale audience (e.g. minted before we started sending RFC 8707 resource).
 */
export async function POST(req: Request) {
  initSchema();
  const url = new URL(req.url);
  const source = url.searchParams.get('source');
  const wipeTokens = url.searchParams.get('tokens') === 'true';
  const db = getDb();

  let clientsRemoved = 0;
  let stateRemoved = 0;
  let tokensRemoved = 0;
  if (source) {
    clientsRemoved = db.prepare('DELETE FROM oauth_clients WHERE source = ?').run(source).changes;
    stateRemoved = db.prepare('DELETE FROM oauth_state WHERE source = ?').run(source).changes;
    if (wipeTokens) tokensRemoved = db.prepare('DELETE FROM oauth_tokens WHERE source = ?').run(source).changes;
  } else {
    clientsRemoved = db.prepare('DELETE FROM oauth_clients').run().changes;
    stateRemoved = db.prepare('DELETE FROM oauth_state').run().changes;
    if (wipeTokens) tokensRemoved = db.prepare('DELETE FROM oauth_tokens').run().changes;
  }

  return NextResponse.json({ ok: true, source: source || 'all', clientsRemoved, stateRemoved, tokensRemoved });
}
