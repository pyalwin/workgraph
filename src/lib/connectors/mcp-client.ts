import type { MCPServerConfig, MCPClient } from './types';
import { getConnectorConfigBySource, toServerConfig } from './config-store';
import { ensureFreshAccessToken } from '../oauth/refresh';

export type { MCPClient };

// Dynamic imports — @modelcontextprotocol/sdk is listed in serverExternalPackages
// so webpack externalizes it rather than bundling it. Regular import() is
// required here so webpack emits proper runtime resolution code; the old
// `new Function` trick bypassed the bundler entirely, causing "Cannot find
// package" errors in the Vercel Lambda environment.
async function loadSdk() {
  const [core, stdio, sse, http] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/sse.js').catch(() => null),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js').catch(() => null),
  ]);
  return { Client: core.Client, stdio, sse, http };
}

export async function connectMCP(server: MCPServerConfig): Promise<MCPClient> {
  const sdk = await loadSdk();
  const client = new sdk.Client({ name: 'workgraph-connector', version: '0.1.0' }, { capabilities: {} });

  let transport: any;
  if (server.transport.kind === 'http') {
    const url = new URL(server.transport.url);
    const headers = server.transport.headers ?? {};
    // Heuristic: if URL ends in /sse, prefer SSE transport. Atlassian's MCP
    // and Linear's MCP both expose /sse endpoints that don't accept the
    // Streamable HTTP POST handshake.
    const looksSse = /\/sse\/?$/.test(url.pathname);
    const useSse = server.transport.preferSse || looksSse;

    console.error(`[connectMCP] http transport: url=${url.toString()} useSse=${useSse} headers=${Object.keys(headers).join(',')}`);

    // Wrapper fetch that logs every request the SDK makes so we can see
    // exactly what's reaching the MCP server.
    const debugFetch: typeof fetch = async (input, init) => {
      const reqUrl = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      const reqHeaders: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) init.headers.forEach((v, k) => { reqHeaders[k] = v; });
        else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) reqHeaders[k] = v;
        else Object.assign(reqHeaders, init.headers);
      }
      const auth = reqHeaders.authorization || reqHeaders.Authorization;
      const authPreview = auth ? `${auth.slice(0, 14)}…(${auth.length}chars)` : '(none)';
      console.error(`[sdk-fetch] ${method} ${reqUrl} auth=${authPreview} ct=${reqHeaders['content-type']||'(none)'}`);
      const r = await fetch(input, init);
      console.error(`[sdk-fetch] → ${r.status} ${r.statusText} (content-type: ${r.headers.get('content-type')||'?'})`);
      return r;
    };

    if (useSse && sdk.sse) {
      transport = new sdk.sse.SSEClientTransport(url, { requestInit: { headers }, fetch: debugFetch });
    } else if (sdk.http) {
      transport = new sdk.http.StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: debugFetch });
    } else if (sdk.sse) {
      transport = new sdk.sse.SSEClientTransport(url, { requestInit: { headers }, fetch: debugFetch });
    } else {
      throw new Error(`No HTTP transport available in @modelcontextprotocol/sdk for server ${server.id}`);
    }
  } else if (server.transport.kind === 'stdio') {
    // Pull leading --env=KEY=VAL args back into the spawned process env, so
    // presets can carry credentials as env without the saved config exposing
    // them to the command line.
    const rawArgs = server.transport.args ?? [];
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(server.transport.env ?? {}) };
    const cmdArgs: string[] = [];
    for (const a of rawArgs) {
      if (a.startsWith('--env=')) {
        const [k, ...rest] = a.slice('--env='.length).split('=');
        if (k) env[k] = rest.join('=');
      } else {
        cmdArgs.push(a);
      }
    }
    // Compat shim: older Atlassian connector rows were saved with JIRA_*
    // env names; the mcp-atlassian package this repo depends on reads
    // ATLASSIAN_*. Mirror the values so both old and new rows work without
    // requiring a destructive DB migration.
    if (env.JIRA_URL && !env.ATLASSIAN_BASE_URL) env.ATLASSIAN_BASE_URL = env.JIRA_URL;
    if (env.JIRA_USERNAME && !env.ATLASSIAN_EMAIL) env.ATLASSIAN_EMAIL = env.JIRA_USERNAME;
    if (env.JIRA_API_TOKEN && !env.ATLASSIAN_API_TOKEN) env.ATLASSIAN_API_TOKEN = env.JIRA_API_TOKEN;
    // And the reverse — newer rows emit ATLASSIAN_* and we want any adapter
    // still reading JIRA_URL to keep working.
    if (env.ATLASSIAN_BASE_URL && !env.JIRA_URL) env.JIRA_URL = env.ATLASSIAN_BASE_URL;
    if (env.ATLASSIAN_EMAIL && !env.JIRA_USERNAME) env.JIRA_USERNAME = env.ATLASSIAN_EMAIL;
    if (env.ATLASSIAN_API_TOKEN && !env.JIRA_API_TOKEN) env.JIRA_API_TOKEN = env.ATLASSIAN_API_TOKEN;
    transport = new sdk.stdio.StdioClientTransport({
      command: server.transport.command,
      args: cmdArgs,
      env,
    });
  }

  await client.connect(transport);

  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      // MCP returns { content: [...] } — adapters expect the raw payload.
      // We extract the first text content as JSON when present, else return raw.
      const content = (result as any)?.content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (first?.type === 'text' && typeof first.text === 'string') {
          try {
            return JSON.parse(first.text);
          } catch {
            return first.text;
          }
        }
        if (first?.type === 'json' && first.json !== undefined) {
          return first.json;
        }
      }
      return result;
    },
    async close() {
      await client.close();
    },
  };
}

export async function resolveServerConfig(
  serverId: string,
  source: string,
  workspaceId: string | null,
  env: NodeJS.ProcessEnv,
): Promise<MCPServerConfig | null> {
  if (workspaceId) {
    let cfg: Awaited<ReturnType<typeof getConnectorConfigBySource>> | null = null;
    try {
      cfg = await getConnectorConfigBySource(workspaceId, source);
    } catch (err: any) {
      console.error(`[resolveServerConfig] DB lookup failed for ${workspaceId}/${source}: ${err.message}`);
    }
    if (cfg) {
      const usesOAuth = (cfg.config.options as any)?.oauth === true;
      console.log(`[resolveServerConfig] ${workspaceId}/${source} found: oauth=${usesOAuth} transport=${cfg.transport} url=${cfg.config.url || '(none)'}`);
      if (usesOAuth) {
        try {
          const token = await ensureFreshAccessToken(workspaceId, source);
          if (token) {
            // Stdio OAuth: inject the access token as an env var on the
            // spawned process. The provider declares which env var name
            // (Slack → SLACK_BOT_TOKEN). Team-id and similar metadata from
            // the token's record are also surfaced as env so the MCP
            // server has everything it needs without manual entry.
            if (cfg.transport === 'stdio') {
              const { getProvider } = await import('../oauth/providers');
              const provider = getProvider(source);
              const envVar = provider?.stdioEnvVar;
              if (!envVar) {
                console.error(`[resolveServerConfig] ${workspaceId}/${source} OAuth+stdio but provider.stdioEnvVar is missing — falling back to saved config`);
                return toServerConfig(cfg);
              }
              const tokenEnv: Record<string, string> = { [envVar]: token.accessToken };
              // Slack: team_id captured during postExchange — Slack MCP
              // server needs SLACK_TEAM_ID to scope channel listings.
              const meta = token.metadata || {};
              if (source === 'slack' && (meta as any).slack_team_id) {
                tokenEnv['SLACK_TEAM_ID'] = String((meta as any).slack_team_id);
              }
              console.log(`[resolveServerConfig] ${workspaceId}/${source} stdio OAuth: injecting ${envVar} (len=${token.accessToken.length})${tokenEnv.SLACK_TEAM_ID ? ' + SLACK_TEAM_ID' : ''}`);
              return {
                id: cfg.serverId,
                label: cfg.serverId,
                transport: {
                  kind: 'stdio',
                  command: cfg.config.command ?? '',
                  args: cfg.config.args ?? [],
                  env: tokenEnv,
                },
              };
            }
            // HTTP OAuth: bearer token in Authorization header.
            const url = cfg.config.url || '';
            console.log(`[resolveServerConfig] ${workspaceId}/${source} attaching OAuth bearer (token len=${token.accessToken.length}) to ${url}`);
            // Always normalize the scheme to canonical "Bearer" — RFC 6750
            // technically allows case-insensitive schemes but real-world
            // resource servers (Atlassian's MCP, others) reject the lowercase
            // "bearer" that some token endpoints return in token_type.
            return {
              id: cfg.serverId,
              label: cfg.serverId,
              transport: {
                kind: 'http',
                url,
                headers: { Authorization: `Bearer ${token.accessToken}` },
              },
            };
          }
          console.error(`[resolveServerConfig] ${workspaceId}/${source} OAuth declared but ensureFreshAccessToken returned null`);
        } catch (err: any) {
          console.error(`[resolveServerConfig] ${workspaceId}/${source} OAuth refresh threw: ${err.message}`);
        }
      }
      return toServerConfig(cfg);
    }
    console.error(`[resolveServerConfig] no config row for ${workspaceId}/${source} — falling back to env`);
  }
  return buildServerFromEnv(serverId, env);
}

export function buildServerFromEnv(serverId: string, env: NodeJS.ProcessEnv): MCPServerConfig | null {
  const prefix = `MCP_${serverId.toUpperCase()}_`;
  const url = env[`${prefix}URL`];
  const command = env[`${prefix}COMMAND`];
  const token = env[`${prefix}TOKEN`];
  const label = env[`${prefix}LABEL`] || serverId;

  if (command) {
    return {
      id: serverId,
      label,
      transport: {
        kind: 'stdio',
        command,
        args: env[`${prefix}ARGS`]?.split(' ').filter(Boolean) ?? [],
      },
    };
  }
  if (url) {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return {
      id: serverId,
      label,
      transport: { kind: 'http', url, headers },
    };
  }
  return null;
}
