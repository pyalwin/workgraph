import { getOAuthToken, isExpired, rotateOAuthToken, type OAuthToken } from '../connectors/oauth-tokens';
import { getProvider, getProviderCredentials } from './providers';
import { getRegisteredClient } from './clients';

/**
 * Fetch a fresh access token for (workspace, source). Performs a refresh-token
 * exchange if the cached token is expired (with a 60s leeway).
 *
 * Returns null if no token is stored, the provider isn't configured, or refresh
 * fails. Callers should treat null as "OAuth not available, fall back to PAT
 * or surface to user".
 */
export async function ensureFreshAccessToken(
  workspaceId: string,
  source: string,
): Promise<OAuthToken | null> {
  const token = await getOAuthToken(workspaceId, source);
  if (!token) return null;
  if (!isExpired(token)) return token;
  return refreshAccessToken(workspaceId, source, token);
}

/**
 * Fetch a fresh access token string for (workspaceId, provider). Convenience
 * wrapper around `ensureFreshAccessToken` for direct-API connectors that share
 * a single OAuth row across multiple adapters (e.g. Google: gmail/gdrive/gcal
 * all read from `provider='google'`).
 *
 * Throws when no token is stored or refresh fails — the calling adapter has
 * no fallback path here, so a clear error is more useful than null.
 */
export async function getOAuthTokenByProvider(
  workspaceId: string,
  provider: string,
): Promise<string> {
  const token = await ensureFreshAccessToken(workspaceId, provider);
  if (!token) {
    const label = getProvider(provider)?.label ?? provider;
    throw new Error(`${label} not connected for this workspace`);
  }
  return token.accessToken;
}

export async function refreshAccessToken(
  workspaceId: string,
  source: string,
  current?: OAuthToken,
): Promise<OAuthToken | null> {
  const token = current ?? (await getOAuthToken(workspaceId, source));
  if (!token || !token.refreshToken) return null;

  const provider = getProvider(source);
  if (!provider) return null;

  // Same resolution order as start/callback: env first, then DCR.
  let clientId: string;
  let clientSecret: string | null;
  let tokenUrl: string;
  let usedDcr = false;
  const envCreds = getProviderCredentials(provider);
  if (envCreds) {
    clientId = envCreds.clientId;
    clientSecret = envCreds.clientSecret;
    tokenUrl = provider.tokenUrl;
  } else {
    const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || '';
    const redirectUri = `${baseUrl.replace(/\/$/, '')}/api/oauth/callback`;
    const dcr = await getRegisteredClient(provider.source, redirectUri);
    if (!dcr) return null;
    clientId = dcr.clientId;
    clientSecret = dcr.clientSecret;
    tokenUrl = dcr.tokenEndpoint || provider.tokenUrl;
    usedDcr = true;
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', token.refreshToken);
  body.set('client_id', clientId);
  if (clientSecret) body.set('client_secret', clientSecret);
  if (provider.audience && !usedDcr) body.set('audience', provider.audience);
  // Same RFC 8707 resource indicator on refresh — keeps the new token's
  // audience pointed at the MCP server. Skip for stdio providers (Slack).
  if (provider.mcpServerUrl) {
    body.set('resource', provider.mcpServerUrl);
  }

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); }
    catch {
      const params = new URLSearchParams(text);
      data = {
        access_token: params.get('access_token'),
        refresh_token: params.get('refresh_token'),
        expires_in: params.get('expires_in') ? Number(params.get('expires_in')) : undefined,
      };
    }
    if (!data?.access_token) return null;

    const expiresAt = data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null;

    return await rotateOAuthToken(workspaceId, source, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? undefined,
      expiresAt,
    });
  } catch {
    return null;
  }
}

/**
 * Best-effort revoke an OAuth token at the provider so the user's
 * "connected apps" / "third-party access" list reflects the disconnect.
 * Never throws — failures are logged and swallowed; the caller (typically
 * the account-deletion cascade) doesn't change behaviour based on outcome.
 *
 * Coverage:
 *   - google:    POST https://oauth2.googleapis.com/revoke (RFC 7009-ish)
 *   - notion:    POST https://api.notion.com/v1/oauth/revoke
 *   - linear:    POST https://api.linear.app/oauth/revoke
 *   - slack:     POST https://slack.com/api/auth.revoke
 *   - jira (atlassian), github: no clean per-user revoke endpoint usable
 *     with just an access token + the credentials we have; logged as TODO
 *     and skipped. Local token row is still deleted by the caller.
 */
export async function revokeOauthToken(provider: string, accessToken: string): Promise<void> {
  if (!accessToken) return;
  const key = provider.toLowerCase();
  try {
    if (key === 'google') {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(),
      }).catch((err) => {
        console.warn(`[oauth] google revoke threw: ${err?.message ?? err}`);
      });
      return;
    }
    if (key === 'notion') {
      await fetch('https://api.notion.com/v1/oauth/revoke', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: accessToken }),
      }).catch((err) => {
        console.warn(`[oauth] notion revoke threw: ${err?.message ?? err}`);
      });
      return;
    }
    if (key === 'linear') {
      await fetch('https://api.linear.app/oauth/revoke', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      }).catch((err) => {
        console.warn(`[oauth] linear revoke threw: ${err?.message ?? err}`);
      });
      return;
    }
    if (key === 'slack') {
      await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      }).catch((err) => {
        console.warn(`[oauth] slack revoke threw: ${err?.message ?? err}`);
      });
      return;
    }
    if (key === 'jira' || key === 'github') {
      // GitHub revocation requires DELETE /applications/{client_id}/grant
      // authenticated with the OAuth-app's client_id+client_secret as basic
      // auth — not a user-bearer call. Atlassian's revoke endpoint
      // (https://auth.atlassian.com/oauth/token/revoke) similarly takes the
      // app's client credentials. Both are doable but worth a follow-up;
      // the local token row is wiped by the caller regardless.
      console.warn(`[oauth] revoke not implemented for ${provider} — local token only`);
      return;
    }
    console.warn(`[oauth] no revoke endpoint for ${provider}; deleting local token only`);
  } catch (err: any) {
    console.warn(`[oauth] ${provider} revoke unexpected error: ${err?.message ?? err}`);
  }
}
