import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import type { MCPServerConfig, MCPTransport } from './types';

export type ConnectorStatus = 'configured' | 'skipped' | 'error';

export type SyncStatus = 'running' | 'success' | 'error';

export const SYNC_STALE_AFTER_MS = 15 * 60 * 1000;

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export function isSyncRunActive(cfg: {
  lastSyncStatus: SyncStatus | null;
  lastSyncStartedAt: string | null;
}): boolean {
  if (cfg.lastSyncStatus !== 'running') return false;
  if (!cfg.lastSyncStartedAt) return false;
  const startedMs = Date.parse(cfg.lastSyncStartedAt);
  if (Number.isNaN(startedMs)) return false;
  return Date.now() - startedMs < SYNC_STALE_AFTER_MS;
}

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

export async function listConnectorConfigs(workspaceId: string): Promise<ConnectorConfig[]> {
  await ensureInit();
  const rows = await getLibsqlDb()
    .prepare('SELECT * FROM workspace_connector_configs WHERE workspace_id = ? ORDER BY slot ASC')
    .all<ConnectorConfigRow>(workspaceId);
  return rows.map(rowToConfig);
}

export async function getConnectorConfig(workspaceId: string, slot: string): Promise<ConnectorConfig | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT * FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?')
    .get<ConnectorConfigRow>(workspaceId, slot);
  return row ? rowToConfig(row) : null;
}

export async function getConnectorConfigBySource(
  workspaceId: string,
  source: string,
): Promise<ConnectorConfig | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare(
      'SELECT * FROM workspace_connector_configs WHERE workspace_id = ? AND source = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get<ConnectorConfigRow>(workspaceId, source);
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

export async function upsertConnectorConfig(input: UpsertInput): Promise<ConnectorConfig> {
  await ensureInit();
  const db = getLibsqlDb();
  const now = new Date().toISOString();
  const existing = await getConnectorConfig(input.workspaceId, input.slot);
  const id = existing?.id ?? uuid();
  const status = input.status ?? 'configured';
  const configStr = JSON.stringify(input.config ?? {});

  if (existing) {
    await db
      .prepare(
        `UPDATE workspace_connector_configs SET source = ?, server_id = ?, transport = ?, config = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(input.source, input.serverId, input.transport, configStr, status, now, id);
  } else {
    await db
      .prepare(
        `INSERT INTO workspace_connector_configs (id, workspace_id, slot, source, server_id, transport, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.slot, input.source, input.serverId, input.transport, configStr, status, now, now);
  }

  const saved = await getConnectorConfig(input.workspaceId, input.slot);
  if (!saved) throw new Error('upsertConnectorConfig: row vanished after upsert');
  return saved;
}

export async function deleteConnectorConfig(workspaceId: string, slot: string): Promise<boolean> {
  await ensureInit();
  const result = await getLibsqlDb()
    .prepare('DELETE FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?')
    .run(workspaceId, slot);
  return result.changes > 0;
}

export async function markConnectorTested(
  workspaceId: string,
  slot: string,
  result: { ok: boolean; error?: string | null },
): Promise<void> {
  await ensureInit();
  const now = new Date().toISOString();
  await getLibsqlDb()
    .prepare(
      `UPDATE workspace_connector_configs SET last_tested_at = ?, last_error = ?, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
    )
    .run(now, result.error ?? null, now, workspaceId, slot);
}

export async function markSyncStarted(workspaceId: string, slot: string): Promise<void> {
  await ensureInit();
  const now = new Date().toISOString();
  await getLibsqlDb()
    .prepare(
      `UPDATE workspace_connector_configs SET last_sync_started_at = ?, last_sync_status = 'running', last_sync_error = NULL, last_sync_log = NULL, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
    )
    .run(now, now, workspaceId, slot);
}

export async function updateSyncLog(workspaceId: string, slot: string, tail: string): Promise<void> {
  await ensureInit();
  const capped = tail.length > 16000 ? tail.slice(-16000) : tail;
  await getLibsqlDb()
    .prepare(
      `UPDATE workspace_connector_configs SET last_sync_log = ? WHERE workspace_id = ? AND slot = ?`,
    )
    .run(capped, workspaceId, slot);
}

export async function markSyncFinished(
  workspaceId: string,
  slot: string,
  result: { ok: boolean; itemsSynced?: number; error?: string | null },
): Promise<void> {
  await ensureInit();
  const now = new Date().toISOString();
  await getLibsqlDb()
    .prepare(
      `UPDATE workspace_connector_configs SET last_sync_completed_at = ?, last_sync_status = ?, last_sync_items = ?, last_sync_error = ?, updated_at = ? WHERE workspace_id = ? AND slot = ?`,
    )
    .run(
      now,
      result.ok ? 'success' : 'error',
      result.itemsSynced ?? null,
      result.error ?? null,
      now,
      workspaceId,
      slot,
    );
}

export async function reapStaleSyncs(): Promise<number> {
  await ensureInit();
  const cutoff = new Date(Date.now() - SYNC_STALE_AFTER_MS).toISOString();
  const now = new Date().toISOString();
  const res = await getLibsqlDb()
    .prepare(
      `UPDATE workspace_connector_configs
       SET last_sync_status = 'error',
           last_sync_completed_at = ?,
           last_sync_error = COALESCE(last_sync_error, 'Sync timed out — marked failed by backstop sweep'),
           updated_at = ?
       WHERE last_sync_status = 'running'
         AND (last_sync_started_at IS NULL OR last_sync_started_at < ?)`,
    )
    .run(now, now, cutoff);
  return res.changes ?? 0;
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
