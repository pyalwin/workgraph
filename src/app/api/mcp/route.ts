import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildChatTools } from '@/lib/ai/chat-tools';
import { getActiveWorkspaceId } from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// MCP server is enabled by default in dev (NODE_ENV !== 'production') so the
// Claude Code chat backend can call workgraph data tools (countItems, listItems,
// searchKnowledge, etc.) via --mcp-config. In production set
// MCP_SERVER_ENABLED=1 explicitly — the endpoint is unauthenticated, so don't
// expose it publicly.
const ENABLED =
  process.env.MCP_SERVER_ENABLED === '1' ||
  (process.env.NODE_ENV !== 'production' && process.env.MCP_SERVER_ENABLED !== '0');

/**
 * Build a fresh McpServer per request (stateless transport). Each tool from
 * chatTools is registered with its zod schema and executor — same code path
 * the in-app chat uses. This lets external MCP clients (Claude Desktop, etc.)
 * call into Workgraph data via the same surface as the chat UI.
 *
 * Disabled by default — set MCP_SERVER_ENABLED=1 to expose. The endpoint is
 * unauthenticated, so only enable behind a network/proxy that adds auth.
 */
function buildServer(workspaceId: string): McpServer {
  const server = new McpServer({ name: 'workgraph', version: '0.1.0' });
  const chatTools = buildChatTools(workspaceId);

  for (const [name, tool] of Object.entries(chatTools)) {
    // The AI SDK's zod and MCP SDK's zod have separate type roots in
    // node_modules — at runtime the shapes are structurally compatible, so
    // we cast through any. (This is the canonical pattern for cross-SDK
    // schema reuse.)
    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    server.registerTool(
      name,
      {
        description: tool.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: shape as any,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (tool.execute as any)(args, {
          toolCallId: `mcp-${Date.now()}`,
          messages: [],
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
  return server;
}

async function handle(req: NextRequest): Promise<Response> {
  if (!ENABLED) {
    return NextResponse.json(
      { error: 'MCP server disabled. Set MCP_SERVER_ENABLED=1 to enable.' },
      { status: 404 },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  });
  // Workspace resolution priority:
  //   1. X-Workspace-Id header — used by the chat route when bridging the
  //      CLI subprocess into MCP (subprocesses have no session cookies).
  //   2. ?workspace= query param.
  //   3. Cookie-based session (legitimate browser callers).
  const headerWs = req.headers.get('x-workspace-id');
  const url = new URL(req.url);
  const queryWs = url.searchParams.get('workspace');
  const workspaceId = headerWs?.trim() || queryWs?.trim() || (await getActiveWorkspaceId());
  console.log(`[mcp] ${req.method} /api/mcp workspace=${workspaceId} ${headerWs ? '(header)' : queryWs ? '(query)' : '(cookie)'}`);
  const server = buildServer(workspaceId);
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
