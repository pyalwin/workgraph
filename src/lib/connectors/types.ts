import type { WorkItemInput } from '../sync/types';

// Forward-declare MCPClient as a structural type so this module stays free
// of server-only imports (mcp-client pulls in the SDK).
export interface MCPClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type ToolCallArgs = (ctx: ConnectorRunContext) => Record<string, unknown>;

export interface ConnectorRunContext {
  since: string | null;
  cursor: string | null;
  limit: number;
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>;  // Saved per-workspace options (e.g. owner, username)
  // Per-bucket last-synced timestamps when the connector declares
  // `incremental` (e.g. for Jira: { "INT": "2026-04-24T...", "OA": "..." }).
  // The runner pre-computes this so adapters don't need DB access.
  bucketLastSynced: Record<string, string>;
}

export interface ConnectorPage {
  raw: unknown;
  rawItems: unknown[];
  nextCursor: string | null;
}

export interface DiscoveryOption {
  id: string;            // stable id (project key, repo full_name, channel id)
  label: string;         // user-facing name
  hint?: string;         // optional secondary text
}

export interface DiscoveryResult {
  // Map of named lists the adapter can return. Keys are arbitrary, but common
  // ones across adapters: projects, repos, channels, calendars, databases.
  [listName: string]: DiscoveryOption[];
}

export interface SourceRef {
  source: string;
  source_id: string;
}

export interface LinkInput {
  from: SourceRef;
  to: SourceRef;
  link_type: string;     // e.g. 'in_repo', 'has_release', 'authored_by'
  confidence?: number;
}

export interface MCPConnector {
  // Stable identifier matching workspace-config sources (e.g. 'jira', 'notion').
  source: string;
  // Human label for logs.
  label: string;
  // MCP server identifier — selects transport from registry.
  serverId: string;
  // Default item_type when toItem doesn't override.
  itemType: string;

  // Primary tool to enumerate items.
  list: {
    tool: string;
    args: ToolCallArgs;
    extractItems: (response: unknown) => unknown[];
    extractCursor?: (response: unknown) => string | null;
    // Connectors that produce items only via postPass (e.g. GitHub now only
    // emits release work_items via per-repo iteration in postPass) can set
    // this flag to skip the list-step tool call entirely. Without it, the
    // runner would invoke an unknown tool on the MCP server and error.
    skip?: boolean;
  };

  // Optional follow-up to fetch full details for each list result.
  detail?: {
    tool: string;
    args: (raw: unknown) => Record<string, unknown>;
    merge: (raw: unknown, detail: unknown) => unknown;
    // Optional predicate: return true to skip the detail call for this raw
    // record (e.g. only call get_pull_request for PRs, not issues).
    skip?: (raw: unknown) => boolean;
  };

  // Map a fully resolved raw record to a WorkItemInput. Return null to skip.
  toItem: (raw: unknown) => WorkItemInput | null;

  // Optional: emit additional WorkItemInputs derived from each raw record
  // (e.g. parent repository for a PR). Items with the same (source, source_id)
  // are deduplicated by the ingest pipeline.
  derivedItems?: (raw: unknown, primary: WorkItemInput | null) => WorkItemInput[];

  // Optional: emit edges between items (e.g. PR -> repo). Resolved to
  // work_items.id by the runner after ingest.
  links?: (raw: unknown, primary: WorkItemInput | null) => LinkInput[];

  // Optional: after the primary list is fully ingested, run a second pass
  // (e.g. fetch releases per configured repo). Receives every primary item
  // collected during the run plus an MCP client and the same ctx the list
  // step saw (for options like the repo multi-select).
  postPass?: (
    client: MCPClient,
    primaries: WorkItemInput[],
    ctx: ConnectorRunContext,
  ) => Promise<{ items: WorkItemInput[]; links: LinkInput[] }>;

  // Allow connector to declare which env vars it needs (for clear errors).
  requiredEnv?: string[];

  // Optional: enables per-bucket incremental sync. The runner uses these to
  // compute MAX(updated_at) per bucket and injects ctx.bucketLastSynced.
  // Useful for connectors scoped by sub-resource (Jira projects, GitHub repos,
  // Slack channels, etc.) so newly-added scope items get backfilled instead of
  // clamped to the global "last synced" that excludes them.
  incremental?: {
    /** metadata field that holds the bucket id, e.g. 'project' for Jira. */
    bucketField: string;
    /** pull bucket ids from saved options (e.g. options.projects → string[]). */
    getBuckets: (options: Record<string, unknown>) => string[];
  };

  // Optional: how to detect references to items of THIS source inside the
  // text of OTHER items. Used by cross-source linking — keeps the regex
  // logic per-adapter so cross-ref is org/system-agnostic. Each function
  // is a pure parse of free text → list of canonical source_ids.
  //
  //  Examples:
  //    Jira/Linear:  text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g)
  //    GitHub:       /\b([\w-]+\/[\w-]+)#(\d+)\b/g  → "owner/repo#NNN"
  //    Notion URLs:  /notion\.so\/[a-f0-9]{32}/g
  //    Slack URLs:   /slack\.com\/archives\/[A-Z0-9]+\/p\d+/g
  idDetection?: {
    findReferences: (text: string) => string[];
  };

  // Optional: discover named lists (projects, repos, channels) the user can
  // multi-select to scope what gets synced. Called via the same MCP client.
  // The shape of supportedLists tells the UI what pickers to render.
  supportedLists?: { id: string; label: string; helpText?: string; mapsToOption: string }[];
  discover?: (
    client: MCPClient,
    listName: string,
    env: NodeJS.ProcessEnv,
    options?: Record<string, unknown>,
  ) => Promise<DiscoveryOption[]>;

  // Optional: called once before the list phase to resolve any options that
  // can only be determined at runtime (e.g. Atlassian cloudId discovery via
  // getAccessibleAtlassianResources). Returns a (possibly enriched) copy of
  // current options. Connectors that implement this should be idempotent —
  // skip discovery when the required value is already present.
  resolveOptions?: (
    client: MCPClient,
    current: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
  ) => Promise<Record<string, unknown>>;
}

export type MCPTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string>; preferSse?: boolean };

export interface MCPServerConfig {
  id: string;
  label: string;
  transport: MCPTransport;
}
