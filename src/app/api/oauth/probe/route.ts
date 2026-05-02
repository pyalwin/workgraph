import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getOAuthToken } from '@/lib/connectors/oauth-tokens';
import { getProvider } from '@/lib/oauth/providers';
import { getRegisteredClient } from '@/lib/oauth/clients';

export const dynamic = 'force-dynamic';

/**
 * GET /api/oauth/probe?workspace=engineering&source=jira[&url=...]
 *
 * Bypasses the MCP SDK to make a raw HTTP request against the configured MCP
 * server URL with the saved bearer. Returns the raw status, response headers,
 * and body so we can see exactly what the server says about the token.
 *
 * Token value is NEVER returned in the response — only its length and prefix.
 */
export async function GET(req: Request) {
  await ensureSchemaAsync();
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspace') || 'engineering';
  const source = url.searchParams.get('source') || 'jira';
  const overrideUrl = url.searchParams.get('url');

  const provider = getProvider(source);
  if (!provider) {
    return NextResponse.json({ ok: false, error: `No provider for ${source}` }, { status: 400 });
  }

  const token = await getOAuthToken(workspaceId, source);
  if (!token) {
    return NextResponse.json({ ok: false, error: `No token saved for ${workspaceId}/${source}` }, { status: 404 });
  }

  const dcr = await getRegisteredClient(source, `${process.env.OAUTH_REDIRECT_BASE_URL || ''}/api/oauth/callback`);

  // Try multiple variants — sometimes the right answer is just a different header.
  const targetUrlCandidate = overrideUrl || provider.mcpServerUrl;
  if (!targetUrlCandidate) {
    return NextResponse.json({ ok: false, error: `No probe URL: provide ?url=… or configure mcpServerUrl for ${source}` }, { status: 400 });
  }
  const targetUrl: string = targetUrlCandidate;
  const variants: Array<{ name: string; headers: Record<string, string> }> = [
    { name: 'Bearer (default)', headers: { Authorization: `${token.tokenType} ${token.accessToken}`, Accept: 'application/json, text/event-stream' } },
    { name: 'Bearer + lowercase', headers: { authorization: `Bearer ${token.accessToken}`, accept: 'text/event-stream' } },
    { name: 'X-Atlassian-Token', headers: { 'X-Atlassian-Token': `Bearer ${token.accessToken}` } },
  ];

  // Read the response with a hard cap — SSE endpoints stream forever, so we
  // need to bail after a small window or response size to avoid hanging.
  async function readBounded(res: Response, maxBytes = 4096, timeoutMs = 4000): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (Date.now() > deadline) break;
        const remaining = deadline - Date.now();
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, remaining))),
        ]);
        if (next.done) break;
        chunks.push(next.value!);
        total += next.value!.byteLength;
        if (total >= maxBytes) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  }

  async function probe(name: string, init: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(targetUrl, { ...init, signal: ctrl.signal });
      const body = await readBounded(res);
      return {
        variant: name,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        bodyPreview: body.slice(0, 500),
        bodyLen: body.length,
      };
    } catch (err: any) {
      return { variant: name, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  const probes = await Promise.all([
    ...variants.map((v) => probe(v.name, { method: 'GET', headers: v.headers })),
    probe('POST initialize (StreamableHTTP)', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wg-probe', version: '0' } } }),
    }),
  ]);

  return NextResponse.json({
    ok: true,
    workspace: workspaceId,
    source,
    targetUrl,
    tokenInfo: {
      length: token.accessToken.length,
      prefix: token.accessToken.slice(0, 8) + '…',
      type: token.tokenType,
      scope: token.scope,
      expiresAt: token.expiresAt,
      hasRefresh: Boolean(token.refreshToken),
      metadata: token.metadata,
    },
    dcrInfo: dcr ? {
      clientIdPrefix: dcr.clientId.slice(0, 12) + '…',
      authEndpoint: dcr.authorizationEndpoint,
      tokenEndpoint: dcr.tokenEndpoint,
      registeredAt: dcr.registeredAt,
    } : null,
    probes,
  });
}
