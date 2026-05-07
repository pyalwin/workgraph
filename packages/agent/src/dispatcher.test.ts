/**
 * Tests for the dispatcher and generic runtime.
 *
 * Run with: node --test dist/dispatcher.test.js
 * (build first: npm run build in packages/agent)
 *
 * All tests inject streamClaude and resolveWorkspace via the overrides
 * parameter to avoid spawning real processes or touching the filesystem.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHandler, getHandler, dispatch } from './dispatcher.js';
import type { JobContext } from './dispatcher.js';
import type { Job, AgentConfig, RuntimeEvent } from './types.js';
import type { ClaudeStream } from './drivers/claude.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-id-001',
    kind: 'noop',
    params: {},
    ...overrides,
  };
}

const STUB_CONFIG: AgentConfig = {
  agent_id: 'test-agent',
  agent_token: 'test-token',
  base_url: 'http://localhost:3000',
  paired_at: '2026-01-01T00:00:00Z',
};

/**
 * Minimal in-memory EventSink that records emitted events.
 * Does NOT do any network I/O.
 */
class MemorySink {
  events: RuntimeEvent[] = [];
  closed = false;

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Build a fake ClaudeStream from a fixed list of events.
 */
function makeClaudeStream(events: RuntimeEvent[], sessionId?: string): ClaudeStream {
  let capturedSessionId: string | undefined = sessionId;
  const stream: ClaudeStream = {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        yield ev;
      }
    },
    get sessionId() {
      return capturedSessionId;
    },
  };
  // suppress unused variable warning
  void capturedSessionId;
  return stream;
}

const noopResolveWorkspace: JobContext['resolveWorkspace'] = async () => ({
  path: '/tmp/test-repo',
  sha: 'deadbeef',
});

// ────────────────────────────────────────────────────────────────────────────
// Registry tests
// ────────────────────────────────────────────────────────────────────────────

test('getHandler returns undefined for unregistered kind', () => {
  assert.equal(getHandler('nonexistent.kind.xyz'), undefined);
});

test('registerHandler then getHandler returns the registered handler', () => {
  const handler = async () => ({ status: 'done' as const, payload: null });
  registerHandler('test.registry.check', handler);
  assert.equal(getHandler('test.registry.check'), handler);
});

test('noop handler is registered by default', () => {
  assert.ok(getHandler('noop') !== undefined, 'noop should be registered at module load');
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch — noop handler (happy path)
// ────────────────────────────────────────────────────────────────────────────

test('dispatch routes noop kind to noopHandler → done', async () => {
  const sink = new MemorySink();
  const result = await dispatch(makeJob({ kind: 'noop' }), sink as never, STUB_CONFIG);

  assert.equal(result.status, 'done');

  // Should have emitted at least a finish event.
  const finish = sink.events.find((e) => e.type === 'finish');
  assert.ok(finish !== undefined, 'noop should emit a finish event');
  if (finish?.type === 'finish') {
    assert.equal(finish.reason, 'stop');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch — custom handler registration
// ────────────────────────────────────────────────────────────────────────────

test('dispatch calls a freshly registered custom handler', async () => {
  let called = false;
  registerHandler('test.custom.hello', async (_job, _ctx) => {
    called = true;
    return { status: 'done', payload: { greeting: 'hello' } };
  });

  const sink = new MemorySink();
  const result = await dispatch(makeJob({ kind: 'test.custom.hello' }), sink as never, STUB_CONFIG);

  assert.ok(called, 'custom handler should have been called');
  assert.equal(result.status, 'done');
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch — unknown kind, no generic shape → failed
// ────────────────────────────────────────────────────────────────────────────

test('dispatch returns failed when kind is unknown and params are not generic', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({ kind: 'totally.unknown.kind.zzz', params: { foo: 'bar' } }),
    sink as never,
    STUB_CONFIG,
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /no handler registered/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch — unknown kind, generic shape → routes to generic runtime
// ────────────────────────────────────────────────────────────────────────────

test('dispatch routes unknown kind to generic runtime when params match generic shape', async () => {
  const textEvents: RuntimeEvent[] = [
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'world' },
    { type: 'finish', reason: 'stop' },
  ];

  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'some.future.kind',
      params: {
        cli: 'claude',
        prompt: 'Say hello',
        repo: 'owner/repo',
        ref: 'main',
      },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: noopResolveWorkspace,
      streamClaude: () => makeClaudeStream(textEvents),
    },
  );

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['chars'], 11); // 'Hello world'
    assert.equal(payload['ref'], 'deadbeef');
  }
});

test('dispatch routes job to generic runtime when params.runtime === "generic"', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'some.kind.without.handler',
      params: {
        runtime: 'generic',
        cli: 'claude',
        prompt: 'Do something',
        repo: 'owner/repo',
      },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: noopResolveWorkspace,
      streamClaude: () =>
        makeClaudeStream([
          { type: 'text-delta', text: 'Done' },
          { type: 'finish', reason: 'stop' },
        ]),
    },
  );

  assert.equal(result.status, 'done');
});

// ────────────────────────────────────────────────────────────────────────────
// Generic runtime — validation
// ────────────────────────────────────────────────────────────────────────────

test('generic runtime fails when cli param is invalid', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.invalid.cli',
      params: { cli: 'gpt4', prompt: 'x', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    { resolveWorkspace: noopResolveWorkspace },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /invalid cli/);
  }
});

test('generic runtime fails for codex (not implemented in v1)', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.codex',
      params: { cli: 'codex', prompt: 'x', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    { resolveWorkspace: noopResolveWorkspace },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /not implemented in v1/);
  }
});

test('generic runtime fails for gemini (not implemented in v1)', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.gemini',
      params: { cli: 'gemini', prompt: 'x', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    { resolveWorkspace: noopResolveWorkspace },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /not implemented in v1/);
  }
});

test('generic runtime fails when prompt is missing', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.no.prompt',
      params: { cli: 'claude', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    { resolveWorkspace: noopResolveWorkspace },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /prompt/);
  }
});

test('generic runtime fails when repo is missing', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.no.repo',
      params: { cli: 'claude', prompt: 'hello' },
    }),
    sink as never,
    STUB_CONFIG,
    { resolveWorkspace: noopResolveWorkspace },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /repo/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Generic runtime — workspace resolver failure
// ────────────────────────────────────────────────────────────────────────────

test('generic runtime returns failed when resolveWorkspace throws', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.workspace.error',
      params: { cli: 'claude', prompt: 'hello', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: async () => {
        throw new Error('git clone failed: authentication required');
      },
      streamClaude: () => makeClaudeStream([]),
    },
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /workspace resolver error/);
    assert.match(result.error, /authentication required/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Generic runtime — event piping and accumulation
// ────────────────────────────────────────────────────────────────────────────

test('generic runtime pipes all events from streamClaude into the sink', async () => {
  const textEvents: RuntimeEvent[] = [
    { type: 'log', level: 'info', message: 'starting' },
    { type: 'text-delta', text: 'chunk1' },
    { type: 'text-delta', text: 'chunk2' },
    { type: 'usage', input_tokens: 10, output_tokens: 5 },
    { type: 'finish', reason: 'stop' },
  ];

  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.pipe.test',
      params: { cli: 'claude', prompt: 'test', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: noopResolveWorkspace,
      streamClaude: () => makeClaudeStream(textEvents),
    },
  );

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['chars'], 12); // 'chunk1chunk2'
  }

  // All events from the stream should appear in the sink (plus the workspace log).
  // The workspace log is emitted before the stream starts.
  const types = sink.events.map((e) => e.type);
  assert.ok(types.includes('log'), 'should have log events');
  assert.ok(types.includes('text-delta'), 'should have text-delta events');
  assert.ok(types.includes('usage'), 'should have usage events');
  assert.ok(types.includes('finish'), 'should have finish event');
});

// ────────────────────────────────────────────────────────────────────────────
// Generic runtime — finish reason propagation
// ────────────────────────────────────────────────────────────────────────────

test('generic runtime returns failed when finish reason is error', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.finish.error',
      params: { cli: 'claude', prompt: 'x', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: noopResolveWorkspace,
      streamClaude: () =>
        makeClaudeStream([{ type: 'finish', reason: 'error', error: 'something went wrong' }]),
    },
  );

  assert.equal(result.status, 'failed');
});

test('generic runtime returns failed when finish reason is cancelled', async () => {
  const sink = new MemorySink();
  const result = await dispatch(
    makeJob({
      kind: 'generic.finish.cancelled',
      params: { cli: 'claude', prompt: 'x', repo: 'owner/repo' },
    }),
    sink as never,
    STUB_CONFIG,
    {
      resolveWorkspace: noopResolveWorkspace,
      streamClaude: () => makeClaudeStream([{ type: 'finish', reason: 'cancelled' }]),
    },
  );

  assert.equal(result.status, 'failed');
});

// ────────────────────────────────────────────────────────────────────────────
// ctx.log helper
// ────────────────────────────────────────────────────────────────────────────

test('custom handler can use ctx.log to emit log events', async () => {
  registerHandler('test.ctx.log', async (_job, ctx) => {
    ctx.log('warn', 'test warning');
    return { status: 'done', payload: null };
  });

  const sink = new MemorySink();
  await dispatch(makeJob({ kind: 'test.ctx.log' }), sink as never, STUB_CONFIG);

  const logEvent = sink.events.find(
    (e) => e.type === 'log' && e.level === 'warn' && e.message === 'test warning',
  );
  assert.ok(logEvent !== undefined, 'should find the warning log event');
});
