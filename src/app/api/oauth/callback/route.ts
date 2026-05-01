import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { consumeFlowState, liveStateCount } from '@/lib/oauth/state';
import {
  describeMissingCreds,
  getProvider,
  getProviderCredentials,
} from '@/lib/oauth/providers';
import { getRegisteredClient } from '@/lib/oauth/clients';
import { saveOAuthToken } from '@/lib/connectors/oauth-tokens';
import { upsertConnectorConfig, getConnectorConfig } from '@/lib/connectors/config-store';
import { getConnector } from '@/lib/connectors/registry';
import { CONNECTOR_PRESETS } from '@/lib/connectors/presets';

export const dynamic = 'force-dynamic';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * GET /api/oauth/callback?code=...&state=...
 *
 * Validates state, exchanges code for tokens, persists encrypted tokens,
 * and creates/updates the connector config so the rest of the system
 * (sync, discover, panel) can pick the OAuth path automatically.
 */
export async function GET(req: Request) {
  initSchema();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const oauthErrorDesc = url.searchParams.get('error_description');

  if (oauthError) {
    return errorPage(oauthError, oauthErrorDesc || 'Authorization was denied or failed.');
  }
  if (!code || !stateParam) {
    return errorPage('missing_params', 'Authorization callback missing code or state.');
  }

  const flow = consumeFlowState(stateParam);
  if (!flow) {
    const remaining = liveStateCount();
    return errorPage(
      'invalid_state',
      `Callback state ${stateParam.slice(0, 12)}… was not found in the database.\n\n` +
      `${remaining} other state row(s) currently in flight.\n\n` +
      `Most common causes:\n` +
      `1. This URL was hit twice (browser reload, back button, or a link prefetcher)\n` +
      `2. The dev server restarted between Connect and the redirect (state is in SQLite — survives restart, but if the file moved or something blew away rows…)\n` +
      `3. Two different dev servers (different ports) are reading from different DBs\n\n` +
      `Try: open a fresh tab, go to /settings?tab=connectors&source=jira, click Connect, complete the flow once. ` +
      `Watch the dev server terminal for [oauth state] lines.`,
    );
  }

  const provider = getProvider(flow.source);
  if (!provider) return errorPage('no_provider', `No OAuth provider for ${flow.source}.`);

  // Resolve creds the same way /start did: env first, then DCR cache.
  let clientId: string;
  let clientSecret: string | null;
  let redirectUri: string;
  let tokenUrl: string;
  let usedDcr = false;

  const envCreds = getProviderCredentials(provider);
  if (envCreds) {
    clientId = envCreds.clientId;
    clientSecret = envCreds.clientSecret;
    redirectUri = envCreds.redirectUri;
    tokenUrl = provider.tokenUrl;
  } else {
    const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || new URL(req.url).origin;
    const dcrRedirect = `${baseUrl.replace(/\/$/, '')}/api/oauth/callback`;
    const dcr = getRegisteredClient(provider.source, dcrRedirect);
    if (!dcr) return errorPage('no_credentials', describeMissingCreds(provider));
    clientId = dcr.clientId;
    clientSecret = dcr.clientSecret;
    redirectUri = dcr.redirectUri;
    tokenUrl = dcr.tokenEndpoint || provider.tokenUrl;
    usedDcr = true;
  }

  // Exchange the code for tokens.
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('client_id', clientId);
  body.set('code_verifier', flow.codeVerifier);
  if (clientSecret) body.set('client_secret', clientSecret);
  // Atlassian's legacy /oauth/token endpoint requires audience; the
  // MCP-spec endpoint discovered via DCR doesn't accept it. Only send when
  // we're talking to the legacy endpoint (env-configured static client).
  if (provider.audience && !usedDcr) body.set('audience', provider.audience);
  // RFC 8707 resource indicator — required by MCP spec so the issued token
  // has the right audience to call the MCP server. Mirror what /start sent.
  // Skip for stdio providers (Slack) — there's no remote MCP server.
  if (provider.mcpServerUrl) {
    body.set('resource', provider.mcpServerUrl);
  }

  console.error(`[oauth ${flow.source}] exchanging code at ${tokenUrl} (client=${clientId.slice(0, 12)}…, redirect=${redirectUri})`);

  let tokens: TokenResponse;
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const text = await res.text();
    console.error(`[oauth ${flow.source}] token endpoint responded ${res.status} ${res.statusText} (${text.length} bytes)`);
    if (!res.ok) {
      console.error(`[oauth ${flow.source}] error body: ${text.slice(0, 500)}`);
      return errorPage(
        'token_exchange_failed',
        `${provider.label} token exchange returned ${res.status}: ${text.slice(0, 400)}\n\n` +
        `Endpoint: ${tokenUrl}\n` +
        `Client ID: ${clientId.slice(0, 16)}…\n` +
        `Redirect URI: ${redirectUri}\n\n` +
        `Try connecting again. If this persists, the registered client may have expired — delete the row from oauth_clients and retry.`,
      );
    }
    // Most providers return JSON; GitHub returns x-www-form-urlencoded by default
    // unless Accept: application/json is set (which we did).
    try { tokens = JSON.parse(text); }
    catch {
      const params = new URLSearchParams(text);
      tokens = {
        access_token: params.get('access_token') || '',
        refresh_token: params.get('refresh_token') || undefined,
        token_type: params.get('token_type') || undefined,
        expires_in: params.get('expires_in') ? Number(params.get('expires_in')) : undefined,
        scope: params.get('scope') || undefined,
      };
    }
  } catch (err: any) {
    return errorPage('token_exchange_error', err.message);
  }

  // Slack's oauth.v2.access returns 200 with `ok: false` on errors. The
  // standard token_endpoint contract is HTTP-status based, but Slack
  // tunnels failure into the body — surface it explicitly.
  if ((tokens as any).ok === false) {
    const slackErr = (tokens as any).error || 'unknown_error';
    return errorPage('slack_oauth_error', `Slack returned ok=false: ${slackErr}`);
  }
  if (!tokens.access_token) {
    return errorPage('no_access_token', 'Provider response did not include an access_token.');
  }

  // Optional post-exchange enrichment (e.g., Atlassian accessible-resources).
  let metadata: Record<string, unknown> = {};
  if (provider.postExchange) {
    try {
      metadata = await provider.postExchange(tokens.access_token);
    } catch {
      // Non-fatal — token is still valid.
    }
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  saveOAuthToken({
    workspaceId: flow.workspaceId,
    source: flow.source,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    tokenType: tokens.token_type || 'Bearer',
    scope: tokens.scope || provider.defaultScopes.join(' '),
    expiresAt,
    metadata,
  });

  // Bootstrap the connector config so the rest of the UI sees this as installed.
  // For hosted-MCP providers we save an http config; for stdio providers
  // (Slack) we save the preset's stdio command — the OAuth token is
  // injected at spawn time by resolveServerConfig.
  const adapter = getConnector(flow.source);
  const existing = getConnectorConfig(flow.workspaceId, flow.slot);
  const preset = CONNECTOR_PRESETS[flow.source];
  const isStdioOAuth = !!provider.stdioEnvVar && preset?.stdio;
  upsertConnectorConfig({
    workspaceId: flow.workspaceId,
    slot: flow.slot,
    source: flow.source,
    serverId: adapter.serverId,
    transport: isStdioOAuth ? 'stdio' : 'http',
    config: isStdioOAuth
      ? {
          command: preset.stdio!.command,
          args: preset.stdio!.args,
          // No token in args — runtime fetches from oauth_tokens and
          // injects it as env when spawning.
          options: { ...(existing?.config.options || {}), oauth: true },
        }
      : {
          url: provider.mcpServerUrl,
          // No token in args/url — runtime fetches from oauth_tokens table.
          options: { ...(existing?.config.options || {}), oauth: true },
        },
    status: 'configured',
  });

  // Bounce back to the settings page (or wherever the user came from).
  const target = flow.returnTo || '/settings?tab=connectors';
  return NextResponse.redirect(new URL(target, req.url).toString(), { status: 302 });
}

function errorPage(code: string, description: string): Response {
  const safe = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[c]!));
  const html = `<!DOCTYPE html>
<html><head><title>OAuth error</title>
<style>body{font-family:system-ui;max-width:640px;margin:80px auto;padding:0 24px;color:#222;line-height:1.5}
h1{font-size:18px;margin-bottom:8px}.code{font-family:ui-monospace,monospace;font-size:12px;color:#888;margin-bottom:16px}
.desc{padding:12px 14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:13px;white-space:pre-wrap;font-family:ui-monospace,monospace;line-height:1.45}
a{color:#3b82f6;text-decoration:none;font-size:13px;display:inline-block;margin-top:24px;margin-right:16px}</style></head>
<body><h1>Couldn't complete connection</h1><div class="code">${safe(code)}</div><div class="desc">${safe(description)}</div><a href="/settings?tab=connectors">← Back to settings</a></body></html>`;
  return new Response(html, { status: 400, headers: { 'Content-Type': 'text/html' } });
}
