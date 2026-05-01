#!/usr/bin/env tsx
// Load .env.local before anything that touches WORKGRAPH_SECRET_KEY (encryption).
// Next.js loads it automatically; standalone tsx doesn't.
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: false });

import { getConnector, listConnectors } from '../src/lib/connectors/registry';
import { runConnector, lastSyncedAt } from '../src/lib/connectors/runner';
import { connectMCP, resolveServerConfig, type MCPClient } from '../src/lib/connectors/mcp-client';
import { getConnectorConfigBySource } from '../src/lib/connectors/config-store';

interface CliFlags {
  source: string | null;
  workspaceId: string | null;
  fromStdin: boolean;
  since: string | null;
  cursor: string | null;
  limit: number;
  pageSize: number;
  dryRun: boolean;
  list: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    source: null,
    workspaceId: process.env.WORKGRAPH_WORKSPACE_ID || null,
    fromStdin: false,
    since: null,
    cursor: null,
    limit: 20,
    pageSize: 100,
    dryRun: false,
    list: false,
    verbose: false,
  };
  for (const arg of argv) {
    if (arg === '--list' || arg === '-l') flags.list = true;
    else if (arg === '--from-stdin') flags.fromStdin = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true;
    else if (arg.startsWith('--since=')) flags.since = arg.slice('--since='.length);
    else if (arg.startsWith('--cursor=')) flags.cursor = arg.slice('--cursor='.length);
    else if (arg.startsWith('--limit=')) flags.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--page-size=')) flags.pageSize = Number(arg.slice('--page-size='.length));
    else if (arg.startsWith('--workspace=')) flags.workspaceId = arg.slice('--workspace='.length);
    else if (!arg.startsWith('-') && !flags.source) flags.source = arg;
  }
  return flags;
}

async function readStdin(): Promise<unknown[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  // Accept either a single response object or an array of pages.
  return Array.isArray(parsed) ? [{ items: parsed, results: parsed, issues: parsed, files: parsed, meetings: parsed, nodes: parsed }] : [parsed];
}

function printUsage() {
  console.log(`Usage: tsx scripts/sync-mcp.ts <source> [options]

Sources: ${listConnectors().map((c) => c.source).join(', ')}

Options:
  --from-stdin         Read MCP responses from stdin (use with claude -p orchestration)
  --since=<ISO>        Override since timestamp (defaults to last sync)
  --cursor=<token>     Resume from cursor
  --limit=<n>          Max pages (default 20)
  --page-size=<n>      Hint to adapter for items per page (default 100)
  --dry-run            Skip ingest, print mapped counts
  --list               List registered connectors

Environment (per server):
  MCP_<ID>_URL         HTTP MCP server URL
  MCP_<ID>_TOKEN       Bearer token (sent as Authorization header)
  MCP_<ID>_COMMAND     Stdio MCP server command
  MCP_<ID>_ARGS        Stdio MCP server args (space-separated)
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.list) {
    for (const c of listConnectors()) {
      console.log(`${c.source.padEnd(12)} ${c.label.padEnd(28)} server=${c.serverId}`);
    }
    return;
  }

  if (!flags.source) {
    printUsage();
    process.exit(1);
  }

  const connector = getConnector(flags.source);

  // Pull the saved per-workspace options (owner, username, etc.) so adapters
  // can read them from ctx.options without each one needing env vars.
  let savedOptions: Record<string, unknown> = {};
  if (flags.workspaceId) {
    try {
      const cfg = getConnectorConfigBySource(flags.workspaceId, connector.source);
      if (cfg?.config?.options) savedOptions = cfg.config.options;
    } catch {
      // ignore — adapters fall back to env vars
    }
  }

  let client: MCPClient | null = null;
  let rawPages: unknown[] | undefined;

  if (flags.fromStdin) {
    rawPages = await readStdin();
    if (rawPages.length === 0) {
      console.error(`[sync-mcp] No stdin data for ${connector.source}`);
      process.exit(1);
    }
  } else {
    const server = await resolveServerConfig(connector.serverId, connector.source, flags.workspaceId, process.env);
    if (!server) {
      console.error(`[sync-mcp] No MCP server config for ${connector.serverId}.`);
      console.error(`           Configure via the workspace UI, or set MCP_${connector.serverId.toUpperCase()}_URL or MCP_${connector.serverId.toUpperCase()}_COMMAND.`);
      console.error(`           Or pipe pre-fetched JSON with --from-stdin.`);
      process.exit(2);
    }
    const missing = (connector.requiredEnv || []).filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`[sync-mcp] Missing required env: ${missing.join(', ')}`);
      process.exit(2);
    }
    client = await connectMCP(server);
  }

  const since = flags.since ?? lastSyncedAt(connector.source);
  console.error(`[sync-mcp] ${connector.label} since=${since ?? 'never'} mode=${flags.fromStdin ? 'stdin' : 'mcp'}`);

  try {
    const result = await runConnector(connector, {
      client,
      rawPages,
      since,
      cursor: flags.cursor,
      limit: flags.limit,
      pageSize: flags.pageSize,
      dryRun: flags.dryRun,
      verbose: flags.verbose,
      options: savedOptions,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close();
  }
}

main().catch((err) => {
  console.error(`[sync-mcp] failed: ${err?.message || err}`);
  process.exit(1);
});
