import { v4 as uuid } from 'uuid';
import { getDb } from '../db';
import { initSchema } from '../schema';
import type { MCPServerConfig, MCPTransport } from './types';

export type ConnectorStatus = 'configured' | 'skipped' | 'error';

export type SyncStatus = 'running' | 'success' | 'error';

export interface ConnectorConfigRow {
  id: string;
  workspace_id: string;
  slot: string;
  source: string;
  server_id: string;
  transport: 'http' | 'stdio';
  config: string;
  status: ConnectorStatus;
  last_tested_at: string | null;
  last_error: string | null;
  last_sync_started_at: string | null;
  last_sync_completed_at: string | null;
  last_sync_status: SyncStatus | null;
  last_sync_items: number | null;
  last_sync_error: string | null;
  last_sync_log: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectorConfig {
  id: string;
  workspaceId: string;
  slot: string;
  source: string;
  serverId: string;
  transport: 'http' | 'stdio';
  status: ConnectorStatus;
  lastTestedAt: string | null;
  lastError: string | null;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncItems: number | null;
  lastSyncError: string | null;
  lastSyncLog: string | null;
  // Secrets are returned but the API layer should redact for non-owner reads.
  config: ConnectorConfigPayload;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorConfigPayload {
  url?: string;
  token?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  // Adapter-specific knobs (e.g. cloudId for Atlassian, projects filter, etc.)
  options?: Record<string, unknown>;
}

function rowToConfig(row: ConnectorConfigRow): ConnectorConfig {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slot: row.slot,
    source: row.source,
    serverId: row.server_id,
    transport: row.transport,
    status: row.status,
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    lastSyncStartedAt: row.last_sync_started_at ?? null,
    lastSyncCompletedAt: row.last_sync_completed_at ?? null,
    lastSyncStatus: (row.last_sync_status ?? null) as SyncStatus | null,
    lastSyncItems: row.last_sync_items ?? null,
    lastSyncError: row.last_sync_error ?? null,
    lastSyncLog: row.last_sync_log ?? null,
    config: JSON.parse(row.config || '{}') as ConnectorConfigPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConnectorConfigs(workspaceId: string): ConnectorConfig[] {
  initSchema();
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM workspace_connector_configs WHERE workspace_id = ? ORDER BY slot ASC')
    .all(workspaceId) as ConnectorConfigRow[];
  return rows.map(rowToConfig);
}

export function getConnectorConfig(workspaceId: string, slot: string): ConnectorConfig | null {
  initSchema();
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?')
    .get(workspaceId, slot) as ConnectorConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}

export function getConnectorConfigBySource(workspaceId: string, source: string): ConnectorConfig | null {
  initSchema();
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM workspace_connector_configs WHERE workspace_id = ? AND source = ? ORDER BY updated_at DESC LIMIT 1')
    .get(workspaceId, source) as ConnectorConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}

export interface UpsertInput {
  workspaceId: string;
  slot: string;
  source: string;
  serverId: string;
  transport: 'http' | 'stdio';
  config: ConnectorConfigPayload;
  status?: ConnectorStatus;
}

export function upsertConnectorConfig(input: UpsertInput): ConnectorConfig {
  initSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getConnectorConfig(input.workspaceId, input.slot);
  const id = existing?.id ?? uuid();
  const status = input.status ?? 'configured';
  const configStr = JSON.stringify(input.config ?? {});

  if (existing) {
    db.prepare(
      `UPDATE workspace_connector_configs SET source = ?, server_id = ?, transport = ?, config = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).run(input.source, input.serverId, input.transport, configStr, status, now, id);
  } else {
    db.prepare(
      `INSERT INTO workspace_connector_configs (id, workspace_id, slot, source, server_id, transport, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.workspaceId, input.slot, input.source, input.serverId, input.transport, configStr, status, now, now);
  }

  return getConnectorConfig(input.workspaceId, input.slot)!;
}

export function deleteConnectorConfig(workspaceId: string, slot: string): boolean {
  initSchema();
  const db = getDb();
  const result = db
    .prepare('DELETE FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?')
    .run(workspaceId, slot);
  return result.changes > 0;
}

export function markConnectorTested(
  workspaceId: string,
  slot: string,
  result: { ok: boolean; error?: string | null },
): void {
  // A failed Test action records the error but MUST NOT downgrade the
  // connector's status — the connector is still configured, we just couldn't
  // verify the connection right now (token expired in flight, network blip,
  // MCP server down, etc.). Touching status would hide the management
  // buttons in the UI and confuse the user into reinstalling.
  initSchema();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_connector_configs SET last_tested_at = ?, last_error = ?, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
  ).run(now, result.error ?? null, now, workspaceId, slot);
}

export function markSyncStarted(workspaceId: string, slot: string): void {
  initSchema();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_connector_configs SET last_sync_started_at = ?, last_sync_status = 'running', last_sync_error = NULL, last_sync_log = NULL, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
  ).run(now, now, workspaceId, slot);
}

export function updateSyncLog(workspaceId: string, slot: string, tail: string): void {
  initSchema();
  const db = getDb();
  // Cap stored log to ~16KB to keep the row light
  const capped = tail.length > 16000 ? tail.slice(-16000) : tail;
  db.prepare(
    `UPDATE workspace_connector_configs SET last_sync_log = ? WHERE workspace_id = ? AND slot = ?`,
  ).run(capped, workspaceId, slot);
}

export function markSyncFinished(
  workspaceId: string,
  slot: string,
  result: { ok: boolean; itemsSynced?: number; error?: string | null },
): void {
  initSchema();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_connector_configs SET last_sync_completed_at = ?, last_sync_status = ?, last_sync_items = ?, last_sync_error = ?, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
  ).run(
    now,
    result.ok ? 'success' : 'error',
    result.itemsSynced ?? null,
    result.error ?? null,
    now,
    workspaceId,
    slot,
  );
}

export function toServerConfig(cfg: ConnectorConfig): MCPServerConfig {
  let transport: MCPTransport;
  if (cfg.transport === 'http') {
    const headers = { ...(cfg.config.headers ?? {}) };
    if (cfg.config.token) headers['Authorization'] = `Bearer ${cfg.config.token}`;
    transport = { kind: 'http', url: cfg.config.url ?? '', headers };
  } else {
    transport = {
      kind: 'stdio',
      command: cfg.config.command ?? '',
      args: cfg.config.args ?? [],
    };
  }
  return { id: cfg.serverId, label: cfg.serverId, transport };
}

const SECRET_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|credentials|headers)/i;
const SECRET_VALUE_PATTERN = /(Bearer\s+\S|"Authorization"|secret_[A-Za-z0-9]|lin_api_|ATATT|sk-[A-Za-z0-9])/;

function redactArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return args;
  return args.map((a) => {
    if (!a.startsWith('--env=')) return a;
    const eq = a.indexOf('=', '--env='.length);
    if (eq === -1) return a;
    const key = a.slice('--env='.length, eq);
    const value = a.slice(eq + 1);
    if (SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value)) {
      return `--env=${key}=***`;
    }
    return a;
  });
}

function redactOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!options) return options;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    out[k] = SECRET_KEY_PATTERN.test(k) && v ? '***' : v;
  }
  return out;
}

/**
 * When the user updates a connector without re-entering the secret(s),
 * merge the saved secret env entries (--env=KEY=VAL where KEY/VAL look secret)
 * back into the new args so the existing token survives.
 */
export function mergeStdioSecrets(existing: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (!Array.isArray(next)) return next;
  if (!Array.isArray(existing) || existing.length === 0) return next;

  const nextKeys = new Set<string>();
  for (const a of next) {
    if (!a.startsWith('--env=')) continue;
    const eq = a.indexOf('=', '--env='.length);
    if (eq === -1) continue;
    nextKeys.add(a.slice('--env='.length, eq));
  }

  const carryover: string[] = [];
  for (const a of existing) {
    if (!a.startsWith('--env=')) continue;
    const eq = a.indexOf('=', '--env='.length);
    if (eq === -1) continue;
    const k = a.slice('--env='.length, eq);
    const v = a.slice(eq + 1);
    if (nextKeys.has(k)) continue;
    if (SECRET_KEY_PATTERN.test(k) || SECRET_VALUE_PATTERN.test(v)) {
      carryover.push(a);
    }
  }
  return carryover.length ? [...carryover, ...next] : next;
}

export function redactConfig(cfg: ConnectorConfig): ConnectorConfig {
  const { token, headers, args, options, ...rest } = cfg.config;
  const redactedHeaders = headers
    ? Object.fromEntries(Object.entries(headers).map(([k]) => [k, '***']))
    : undefined;
  return {
    ...cfg,
    config: {
      ...rest,
      headers: redactedHeaders,
      token: token ? '***' : undefined,
      args: redactArgs(args),
      options: redactOptions(options),
    },
  };
}
