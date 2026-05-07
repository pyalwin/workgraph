/**
 * dispatcher — handler registry and job routing.
 *
 * Public API:
 *   registerHandler(kind, handler)  — register a custom handler for a job kind.
 *   getHandler(kind)                — return the registered handler or undefined.
 *   dispatch(job, sink, config)     — run the job, returns JobResult.
 */

import { streamClaude } from './drivers/claude.js';
import { apiFetch } from './client.js';
import { genericRuntime, isGenericJob } from './runtime/generic.js';
import { noopHandler } from './handlers/noop.js';
import type { Job, JobResult, AgentConfig, RuntimeEvent } from './types.js';
import type { EventSink } from './sink.js';
import type { ClaudeStream, StreamClaudeOpts } from './drivers/claude.js';

// ────────────────────────────────────────────────────────────────────────────
// Context passed to every handler
// ────────────────────────────────────────────────────────────────────────────

export interface WorkspaceResult {
  path: string;
  sha: string;
}

export interface JobContext {
  sink: EventSink;
  /** Convenience log helper — emits a log RuntimeEvent into the sink. */
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * Resolves a repo to a local path and the current HEAD sha.
   * Defaults to the real workspace resolver from ./workspace.js.
   * Overrideable for testing.
   */
  resolveWorkspace(opts: { repoKey: string; ref: string }): Promise<WorkspaceResult>;
  /**
   * Streams Claude output.
   * Overrideable for testing.
   */
  streamClaude(opts: StreamClaudeOpts): ClaudeStream;
  /**
   * Raw authenticated fetch against the Workgraph server.
   * Exposed so handlers can POST structured results (e.g. outline JSON).
   */
  client(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// Handler type
// ────────────────────────────────────────────────────────────────────────────

export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobResult>;

// ────────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────────

const registry = new Map<string, JobHandler>();

export function registerHandler(kind: string, handler: JobHandler): void {
  registry.set(kind, handler);
}

export function getHandler(kind: string): JobHandler | undefined {
  return registry.get(kind);
}

// ────────────────────────────────────────────────────────────────────────────
// Default workspace resolver — lazy import so a missing workspace.ts produces
// a clear error rather than a crash at module load time.
// ────────────────────────────────────────────────────────────────────────────

const defaultResolveWorkspace: JobContext['resolveWorkspace'] = async (opts) => {
  try {
    const mod = (await import('./workspace.js')) as { resolveWorkspace: JobContext['resolveWorkspace'] };
    return mod.resolveWorkspace(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `workspace resolver not available (import failed: ${msg}). ` +
        `Ensure workspace.ts is built, or inject a resolveWorkspace override.`,
    );
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────────────────

/**
 * dispatch — routes a job to the appropriate handler.
 *
 * Resolution order:
 *   1. Registered custom handler for job.kind.
 *   2. Generic runtime, if job.params matches the generic shape
 *      (has cli + prompt + repo) OR if job.params.runtime === 'generic'.
 *   3. Otherwise returns { status: 'failed', error: 'no handler ...' }.
 *
 * resolveWorkspace and streamClaude are injectable via overrides for testing.
 */
export async function dispatch(
  job: Job,
  sink: EventSink,
  config: AgentConfig,
  overrides?: {
    resolveWorkspace?: JobContext['resolveWorkspace'];
    streamClaude?: JobContext['streamClaude'];
  },
): Promise<JobResult> {
  const ctx = buildContext(sink, config, overrides);

  // 1. Custom handler?
  const custom = getHandler(job.kind);
  if (custom) {
    return custom(job, ctx);
  }

  // 2. Generic runtime?
  const isGeneric = job.params['runtime'] === 'generic' || isGenericJob(job.params);
  if (isGeneric) {
    return genericRuntime(job, ctx);
  }

  // 3. Nothing matched.
  return {
    status: 'failed',
    error: `no handler registered for kind '${job.kind}' and params do not match the generic runtime shape`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Context builder
// ────────────────────────────────────────────────────────────────────────────

function buildContext(
  sink: EventSink,
  config: AgentConfig,
  overrides?: {
    resolveWorkspace?: JobContext['resolveWorkspace'];
    streamClaude?: JobContext['streamClaude'];
  },
): JobContext {
  return {
    sink,

    log(level: 'info' | 'warn' | 'error', message: string): void {
      sink.emit({ type: 'log', level, message } as RuntimeEvent);
    },

    resolveWorkspace: overrides?.resolveWorkspace ?? defaultResolveWorkspace,

    streamClaude: overrides?.streamClaude ?? streamClaude,

    client(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown> {
      return apiFetch(path, opts ?? {}, config);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in handler registrations
// ────────────────────────────────────────────────────────────────────────────

registerHandler('noop', noopHandler);
