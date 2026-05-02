import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import {
  describeMissingCreds,
  getProvider,
  getProviderCredentials,
} from '@/lib/oauth/providers';
import { generatePkce, generateState, saveFlowState } from '@/lib/oauth/state';
import { resolveDcrClient } from '@/lib/oauth/discovery';

export const dynamic = 'force-dynamic';

/**
 * GET /api/oauth/start?source=jira&workspace=engineering-demo&slot=jira&return_to=/settings?tab=connectors
 *
 * Initiates an OAuth Authorization Code + PKCE flow against the configured
 * provider for `source`, persists the in-flight state, and 302-redirects to
 * the provider's authorization URL.
 */
export async function GET(req: Request) {
  await ensureSchemaAsync();
  const url = new URL(req.url);
  const source = (url.searchParams.get('source') || '').toLowerCase();
  const workspaceId = url.searchParams.get('workspace');
  const slot = url.searchParams.get('slot') || source;
  const returnTo = url.searchParams.get('return_to') || `/settings?tab=connectors&source=${encodeURIComponent(source)}`;

  if (!source || !workspaceId) {
    return NextResponse.json({ ok: false, error: 'source and workspace are required' }, { status: 400 });
  }

  const provider = getProvider(source);
  if (!provider) {
    return NextResponse.json({ ok: false, error: `No OAuth provider registered for source "${source}"` }, { status: 400 });
  }

  // Resolution order: env-provided creds → cached/registered DCR client → fail.
  let clientId: string;
  let redirectUri: string;
  let authorizeUrl: string;

  const envCreds = getProviderCredentials(provider);
  if (envCreds) {
    clientId = envCreds.clientId;
    redirectUri = envCreds.redirectUri;
    authorizeUrl = provider.authorizeUrl;
  } else {
    const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || new URL(req.url).origin;
    const dcrRedirect = `${baseUrl.replace(/\/$/, '')}/api/oauth/callback`;
    const { client, reason } = await resolveDcrClient(provider, dcrRedirect);
    if (!client) {
      return NextResponse.json({
        ok: false,
        error: `Couldn't connect to ${provider.label}: ${reason}. Either set ${`OAUTH_${provider.source.toUpperCase()}_CLIENT_ID`} in your environment, or fix the underlying issue (often: WORKGRAPH_SECRET_KEY not set in .env.local — run \`bunx tsx scripts/gen-secret.ts\`).`,
      }, { status: 500 });
    }
    clientId = client.clientId;
    redirectUri = client.redirectUri;
    authorizeUrl = client.authorizationEndpoint || provider.authorizeUrl;
  }

  const pkce = generatePkce();
  const state = generateState();

  await saveFlowState({
    state,
    workspaceId,
    source,
    slot,
    codeVerifier: pkce.verifier,
    returnTo,
  });

  const authUrl = new URL(authorizeUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', pkce.method);
  if (provider.defaultScopes.length > 0) {
    const sep = provider.scopeSeparator ?? ' ';
    authUrl.searchParams.set('scope', provider.defaultScopes.join(sep));
  }
  if (provider.audience) authUrl.searchParams.set('audience', provider.audience);
  if (provider.extraAuthParams) {
    for (const [k, v] of Object.entries(provider.extraAuthParams)) authUrl.searchParams.set(k, v);
  }
  // RFC 8707 — MCP spec requires the resource indicator on both authorization
  // and token exchange so the auth server mints a token whose audience matches
  // the MCP server URL. Skip for stdio providers (Slack) — there's no remote
  // MCP server to bind the token to.
  if (provider.mcpServerUrl) {
    authUrl.searchParams.set('resource', provider.mcpServerUrl);
  }

  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}
