/**
 * Per-source OAuth provider config. Static for now — Phase 2 will add dynamic
 * client registration so users don't have to manually create OAuth apps.
 *
 * Each provider documents the env vars its registration requires. The /api/oauth/start
 * route refuses to launch unless its provider is fully configured (clear error in UI).
 */

export interface OAuthProvider {
  source: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  // Audience param for OAuth2 servers that require it (Atlassian).
  audience?: string;
  // Provider-specific extras to attach to the auth URL.
  extraAuthParams?: Record<string, string>;
  // Where to send the bearer token after exchange. Hosted-MCP providers
  // (Atlassian, Notion, Linear, GitHub) point here. Stdio-only providers
  // like Slack omit this — the OAuth token is injected as an env var into
  // the spawned MCP process instead.
  mcpServerUrl?: string;
  // For stdio-transport OAuth providers, the env var name that should
  // receive the access token when spawning the MCP process.
  // Example: Slack → 'SLACK_BOT_TOKEN'.
  stdioEnvVar?: string;
  // OAuth scope joiner. Defaults to ' '. Slack v2 uses ','.
  scopeSeparator?: string;
  // RFC 8414 metadata endpoint for Dynamic Client Registration discovery.
  // When set and DCR succeeds, users skip OAuth-app registration entirely.
  metadataUrl?: string;
  // After successful token exchange, optionally call a discovery endpoint
  // (e.g. Atlassian's accessible-resources) and merge results into metadata.
  postExchange?: (accessToken: string) => Promise<Record<string, unknown>>;
}

const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  jira: {
    source: 'jira',
    label: 'Atlassian',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    audience: 'api.atlassian.com',
    defaultScopes: [
      'read:jira-work',
      'read:jira-user',
      'read:me',
      'offline_access',
    ],
    extraAuthParams: { prompt: 'consent' },
    // Atlassian exposes both /v1/sse (SSE) and /v1/mcp (Streamable HTTP).
    // /v1/mcp is what tokens minted via DCR are bound to — /v1/sse rejects
    // those tokens with invalid_token. Verified empirically.
    mcpServerUrl: 'https://mcp.atlassian.com/v1/mcp',
    metadataUrl: 'https://mcp.atlassian.com/.well-known/oauth-authorization-server',
    postExchange: async (accessToken) => {
      try {
        const res = await fetch(ATLASSIAN_RESOURCES_URL, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return {};
        const resources = (await res.json()) as Array<{ id: string; name: string; url: string; scopes: string[] }>;
        return { atlassian_resources: resources, primary_cloud_id: resources[0]?.id || null };
      } catch {
        return {};
      }
    },
  },
  github: {
    source: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['repo', 'read:org', 'read:user'],
    mcpServerUrl: 'https://api.githubcopilot.com/mcp/',
  },
  notion: {
    source: 'notion',
    label: 'Notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    defaultScopes: [],
    extraAuthParams: { owner: 'user' },
    mcpServerUrl: 'https://mcp.notion.com/mcp',
    metadataUrl: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
  },
  linear: {
    source: 'linear',
    label: 'Linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    defaultScopes: ['read'],
    mcpServerUrl: 'https://mcp.linear.app/sse',
    metadataUrl: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
  },
  slack: {
    source: 'slack',
    label: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // Comma-separated bot scopes — read-only set covering channels, threads,
    // DMs, users, and workspace info. Users with token rotation enabled get
    // a refresh_token automatically.
    defaultScopes: [
      'channels:history',
      'channels:read',
      'groups:history',
      'groups:read',
      'im:history',
      'im:read',
      'mpim:history',
      'mpim:read',
      'users:read',
      'team:read',
    ],
    scopeSeparator: ',',
    // Slack ships an stdio MCP server (npx @modelcontextprotocol/server-slack);
    // there's no hosted MCP. After OAuth we inject the bot token as
    // SLACK_BOT_TOKEN into the spawned process env.
    stdioEnvVar: 'SLACK_BOT_TOKEN',
    // Capture team_id from token response so the Slack MCP server has the
    // workspace context it needs without requiring manual entry.
    postExchange: async (accessToken) => {
      try {
        const res = await fetch('https://slack.com/api/auth.test', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return {};
        const data = (await res.json()) as { team_id?: string; team?: string; user_id?: string; url?: string };
        return {
          slack_team_id: data.team_id || null,
          slack_team_name: data.team || null,
          slack_user_id: data.user_id || null,
          slack_workspace_url: data.url || null,
        };
      } catch {
        return {};
      }
    },
  },
};

export function getProvider(source: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[source.toLowerCase()] || null;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string | null;   // null = public client (PKCE only)
  redirectUri: string;
}

/**
 * Read the registered OAuth app credentials from env. Each provider needs:
 *   OAUTH_<PROVIDER>_CLIENT_ID       (required)
 *   OAUTH_<PROVIDER>_CLIENT_SECRET   (optional — public PKCE clients omit it)
 * Plus a global redirect URI:
 *   OAUTH_REDIRECT_BASE_URL          (e.g. http://localhost:3010)
 */
export function getProviderCredentials(provider: OAuthProvider): ProviderCredentials | null {
  const prefix = `OAUTH_${provider.source.toUpperCase()}_`;
  const clientId = process.env[`${prefix}CLIENT_ID`];
  if (!clientId) return null;
  const clientSecret = process.env[`${prefix}CLIENT_SECRET`] || null;
  const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3010';
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl.replace(/\/$/, '')}/api/oauth/callback`,
  };
}

export function describeMissingCreds(provider: OAuthProvider): string {
  const prefix = `OAUTH_${provider.source.toUpperCase()}_`;
  return `Missing OAuth credentials for ${provider.label}. Set ${prefix}CLIENT_ID (and optionally ${prefix}CLIENT_SECRET) plus OAUTH_REDIRECT_BASE_URL in your environment.`;
}
