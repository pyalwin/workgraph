import { getRegisteredClient, saveRegisteredClient, type RegisteredClient } from './clients';
import type { OAuthProvider } from './providers';

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  response_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Fetch the OAuth Authorization Server Metadata (RFC 8414) document.
 * Throws a descriptive error rather than silently returning null so callers
 * can include the real failure reason in user-facing messages.
 */
export async function fetchAuthServerMetadata(provider: OAuthProvider): Promise<AuthServerMetadata | null> {
  if (!provider.metadataUrl) return null;
  try {
    const res = await fetch(provider.metadataUrl, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`metadata fetch returned ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AuthServerMetadata;
  } catch (err: any) {
    throw new Error(`Failed to fetch OAuth metadata from ${provider.metadataUrl}: ${err.message}`);
  }
}

interface DcrRequest {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
  application_type?: string;
}

interface DcrResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

/**
 * RFC 7591 Dynamic Client Registration. Returns null if the auth server
 * doesn't expose a registration endpoint or the request fails.
 */
export async function registerClient(
  provider: OAuthProvider,
  metadata: AuthServerMetadata,
  redirectUri: string,
): Promise<RegisteredClient | null> {
  if (!metadata.registration_endpoint) return null;

  const body: DcrRequest = {
    client_name: 'WorkGraph',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',     // public PKCE client
    application_type: 'web',
    scope: provider.defaultScopes.join(' '),
  };

  let res: Response;
  try {
    res = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new Error(`Network error registering client: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Registration endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as DcrResponse;
  if (!data.client_id) {
    throw new Error('Registration response missing client_id');
  }

  // Note: saveRegisteredClient throws if WORKGRAPH_SECRET_KEY isn't set.
  // We let that bubble — it's the most actionable error a user can see.
  return await saveRegisteredClient({
    source: provider.source,
    redirectUri,
    clientId: data.client_id,
    clientSecret: data.client_secret ?? null,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationResponse: data as unknown as Record<string, unknown>,
  });
}

export interface DcrAttemptResult {
  client: RegisteredClient | null;
  reason: string | null;     // null on success; descriptive error otherwise
}

/**
 * Resolve credentials in order: cached registered client → fresh DCR.
 * Returns the registered client OR a descriptive failure reason — callers
 * use the reason to surface a clear message to the user.
 */
export async function resolveDcrClient(
  provider: OAuthProvider,
  redirectUri: string,
): Promise<DcrAttemptResult> {
  const cached = await getRegisteredClient(provider.source, redirectUri);
  if (cached) return { client: cached, reason: null };

  if (!provider.metadataUrl) {
    return { client: null, reason: `${provider.label} doesn't expose OAuth metadata for Dynamic Client Registration.` };
  }

  let metadata: AuthServerMetadata | null;
  try {
    metadata = await fetchAuthServerMetadata(provider);
  } catch (err: any) {
    return { client: null, reason: err.message };
  }
  if (!metadata) return { client: null, reason: `No metadata returned from ${provider.metadataUrl}` };
  if (!metadata.registration_endpoint) {
    return { client: null, reason: `${provider.label}'s OAuth server doesn't support Dynamic Client Registration.` };
  }

  try {
    const client = await registerClient(provider, metadata, redirectUri);
    return { client, reason: client ? null : 'Registration returned no client' };
  } catch (err: any) {
    return { client: null, reason: err.message };
  }
}
