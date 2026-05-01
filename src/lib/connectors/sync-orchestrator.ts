import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import { markSyncFinished, markSyncStarted, updateSyncLog } from './config-store';

// Per-process map of in-flight syncs so the same connector isn't spawned twice
// concurrently. NOTE: this only protects within one Node worker — for multi-
// process production, use a real job queue or a sqlite-backed lock.
const running = new Map<string, AbortController>();

function key(workspaceId: string, slot: string): string {
  return `${workspaceId}::${slot}`;
}

export interface TriggerResult {
  ok: boolean;
  alreadyRunning?: boolean;
  error?: string;
}

export interface TriggerOptions {
  /** ISO date or 'full' to override the incremental since clamp. Default = incremental from last sync. */
  since?: string;
}

/**
 * Kicks off `bunx tsx scripts/sync-mcp.ts <source> --workspace=<id>` as a
 * detached subprocess. Returns immediately. Sync state is persisted via
 * markSyncStarted/Finished so callers can poll the connector config row.
 */
export function triggerSync(
  workspaceId: string,
  slot: string,
  source: string,
  options: TriggerOptions = {},
): TriggerResult {
  const id = key(workspaceId, slot);
  if (running.has(id)) {
    return { ok: true, alreadyRunning: true };
  }

  // Resolve cwd (Next.js may run from .next/server/...). Find the real repo.
  const cwd = process.env.WORKGRAPH_REPO_ROOT || process.cwd();
  const scriptPath = path.join(cwd, 'scripts', 'sync-mcp.ts');
  const runner = process.env.WORKGRAPH_SYNC_RUNNER || 'bunx';
  const args = ['tsx', scriptPath, source, `--workspace=${workspaceId}`, '--verbose'];
  if (options.since) {
    // 'full' is the sentinel for "no date floor at all" — adapter drops the
    // updated >= clause entirely and pulls genuine full history. Any other
    // value is treated as an ISO date floor.
    const sinceArg = options.since === 'full' ? 'all' : options.since;
    args.push(`--since=${sinceArg}`);
    args.push('--limit=200');  // bigger page cap for backfills
  }

  // Set up log file: logs/sync-{workspace}-{source}.log (overwritten each run)
  const logDir = path.join(cwd, 'logs');
  try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  const logPath = path.join(logDir, `sync-${workspaceId}-${source}.log`);
  const logStream = createWriteStream(logPath);
  const startBanner = `=== ${new Date().toISOString()} ${runner} ${args.join(' ')} ===\n`;
  logStream.write(startBanner);
  process.stderr.write(`[sync] ${workspaceId}/${source} → ${logPath}\n`);

  let abort: AbortController;
  try {
    abort = new AbortController();
    const child = spawn(runner, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      signal: abort.signal,
      env: { ...process.env, WORKGRAPH_WORKSPACE_ID: workspaceId },
    });

    running.set(id, abort);
    markSyncStarted(workspaceId, slot);

    let stdout = '';
    const tail: string[] = [];
    const TAIL_MAX = 100;
    const pushTail = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.length === 0) continue;
        tail.push(line);
        if (tail.length > TAIL_MAX) tail.shift();
      }
    };
    let lastFlush = 0;
    const maybeFlushTail = () => {
      const now = Date.now();
      if (now - lastFlush > 800) {
        lastFlush = now;
        try { updateSyncLog(workspaceId, slot, tail.join('\n')); } catch { /* non-fatal */ }
      }
    };

    child.stdout?.on('data', (b) => {
      const s = b.toString();
      stdout += s;
      logStream.write(s);
      process.stderr.write(`[sync ${source}] ${s}`);
      pushTail(s);
      maybeFlushTail();
    });
    child.stderr?.on('data', (b) => {
      const s = b.toString();
      logStream.write(s);
      process.stderr.write(`[sync ${source}] ${s}`);
      pushTail(s);
      maybeFlushTail();
    });

    child.on('close', (code) => {
      running.delete(id);
      const trailer = `\n=== exit ${code} @ ${new Date().toISOString()} ===\n`;
      logStream.write(trailer);
      logStream.end();
      pushTail(trailer);
      try { updateSyncLog(workspaceId, slot, tail.join('\n')); } catch { /* ignore */ }

      if (code === 0) {
        // sync-mcp.ts emits one JSON object on stdout (pretty-printed). Find
        // the trailing {…} block and parse — robust against leading/trailing
        // whitespace or accidental extra log lines.
        const trimmed = stdout.trim();
        const lastClose = trimmed.lastIndexOf('}');
        const lastOpen = trimmed.lastIndexOf('{', lastClose);
        const candidate = lastOpen >= 0 && lastClose > lastOpen ? trimmed.slice(lastOpen, lastClose + 1) : '';
        let parsed: any = null;
        if (candidate) {
          try { parsed = JSON.parse(candidate); } catch { /* try the whole thing */ }
        }
        if (!parsed) {
          try { parsed = JSON.parse(trimmed); } catch { /* still nothing */ }
        }
        if (parsed) {
          const items = (parsed.itemsSynced ?? 0) + (parsed.itemsUpdated ?? 0);
          const errors: string[] = parsed.errors ?? [];
          const realErrors = errors.filter((e: string) => !e.startsWith('dry-run'));
          markSyncFinished(workspaceId, slot, {
            ok: realErrors.length === 0,
            itemsSynced: items,
            error: realErrors.length ? realErrors.slice(0, 3).join('; ') : null,
          });
        } else {
          markSyncFinished(workspaceId, slot, { ok: false, error: 'Could not parse sync output' });
        }
      } else {
        const lastErrLine = tail.filter((l) => /error|fail/i.test(l)).pop() || `exit code ${code}`;
        markSyncFinished(workspaceId, slot, { ok: false, error: lastErrLine });
      }
    });

    child.on('error', (err) => {
      running.delete(id);
      logStream.write(`spawn error: ${err.message}\n`);
      logStream.end();
      markSyncFinished(workspaceId, slot, { ok: false, error: err.message });
    });

    return { ok: true };
  } catch (err: any) {
    if (running.get(id) === abort!) running.delete(id);
    logStream.write(`orchestrator error: ${err.message}\n`);
    logStream.end();
    markSyncFinished(workspaceId, slot, { ok: false, error: err.message });
    return { ok: false, error: err.message };
  }
}

export function logPathFor(workspaceId: string, source: string): string {
  return path.join(process.env.WORKGRAPH_REPO_ROOT || process.cwd(), 'logs', `sync-${workspaceId}-${source}.log`);
}

export function isSyncRunning(workspaceId: string, slot: string): boolean {
  return running.has(key(workspaceId, slot));
}
