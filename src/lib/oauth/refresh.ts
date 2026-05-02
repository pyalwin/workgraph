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
