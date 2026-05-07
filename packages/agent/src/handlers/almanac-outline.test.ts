/**
 * Tests for the almanac.outline handler.
 *
 * Run with: node --test dist/handlers/almanac-outline.test.js
 * (build first: npm run build in packages/agent)
 *
 * All external I/O (streamClaude, resolveWorkspace, client) is injected
 * via the ctx object — no real processes are spawned.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { almanacOutlineHandler } from './almanac-outline.js';
import type { Job, RuntimeEvent, AgentConfig } from '../types.js';
import type { JobContext } from '../dispatcher.js';
import type { ClaudeStream } from '../drivers/claude.js';

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

class MemorySink {
  events: RuntimeEvent[] = [];

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }

  async close(): Promise<void> {}
}

function makeClaudeStream(events: RuntimeEvent[]): ClaudeStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        yield ev;
      }
    },
    get sessionId() {
      return undefined;
    },
  };
}

function textStream(text: string): ClaudeStream {
  return makeClaudeStream([
    { type: 'text-delta', text },
    { type: 'finish', reason: 'stop' },
  ]);
}

function makeJob(params: Record<string, unknown> = {}): Job {
  return {
    id: 'test-outline-job-001',
    kind: 'almanac.outline',
    params: {
      workspaceId: 'ws-1',
      projectKey: 'my-project',
      repoKey: 'owner/repo',
      ref: 'main',
      doc_id: 'doc-123',
      ...params,
    },
  };
}

const stubResolveWorkspace: JobContext['resolveWorkspace'] = async () => ({
  path: '/tmp/test-repo',
  sha: 'abc1234def5678',
});

/**
 * Minimal valid outline JSON with all nine required sections.
 */
function makeValidOutlineJson(): string {
  const outline = {
    product_summary: 'A task management platform for engineering teams.',
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        role: 'required',
        abstract: 'What the product is, who it is for, and the value it delivers.',
        subsections: [{ title: 'What is Workgraph', abstract: 'Brief intro.' }],
        diagrams_expected: [],
      },
      {
        id: 'problem-and-personas',
        title: 'Problem & Personas',
        role: 'required',
        abstract: 'The problem the product solves and the personas it serves.',
        subsections: [{ title: 'Target personas', abstract: 'Who uses this.' }],
        diagrams_expected: [],
      },
      {
        id: 'key-features',
        title: 'Key Features',
        role: 'required',
        abstract: 'Capability map organised by user value.',
        subsections: [],
        diagrams_expected: [],
      },
      {
        id: 'user-journeys',
        title: 'User Journeys',
        role: 'required',
        abstract: 'End-to-end flows from a user perspective.',
        subsections: [],
        diagrams_expected: ['sequence diagram of onboarding'],
      },
      {
        id: 'core-workflows',
        title: 'Core Workflows',
        role: 'required',
        abstract: 'Key system workflows and lifecycles.',
        subsections: [],
        diagrams_expected: ['workflow flowchart'],
      },
      {
        id: 'how-it-works',
        title: 'How It Works',
        role: 'required',
        abstract: 'Light architectural narrative — major moving parts and data flow.',
        subsections: [],
        diagrams_expected: ['system context diagram'],
      },
      {
        id: 'integrations',
        title: 'Integrations',
        role: 'required',
        abstract: 'External systems the product talks to and what each is used for.',
        subsections: [],
        diagrams_expected: [],
      },
      {
        id: 'configuration-and-operations',
        title: 'Configuration & Operations',
        role: 'required',
        abstract: 'What admins configure and run, including env vars and deployment.',
        subsections: [],
        diagrams_expected: [],
      },
      {
        id: 'engineering-notes',
        title: 'Engineering Notes',
        role: 'required',
        abstract: 'Engineering appendix: where code lives, key modules, glossary.',
        subsections: [],
        diagrams_expected: [],
      },
    ],
  };
  return JSON.stringify(outline);
}

function makeCtx(
  overrides: Partial<{
    streamClaude: JobContext['streamClaude'];
    resolveWorkspace: JobContext['resolveWorkspace'];
    client: JobContext['client'];
    sink: MemorySink;
  }> = {},
): JobContext {
  const sink = overrides.sink ?? new MemorySink();
  return {
    sink: sink as never,
    log(level, message) {
      sink.emit({ type: 'log', level, message });
    },
    resolveWorkspace: overrides.resolveWorkspace ?? stubResolveWorkspace,
    streamClaude: overrides.streamClaude ?? (() => textStream(makeValidOutlineJson())),
    client: overrides.client ?? (async () => ({ ok: true })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — happy path returns done with correct payload', async () => {
  const sink = new MemorySink();
  let postedPath = '';
  let postedBody: unknown;

  const ctx = makeCtx({
    sink,
    streamClaude: () => textStream(makeValidOutlineJson()),
    client: async (path, opts) => {
      postedPath = path;
      postedBody = opts?.body;
      return { ok: true };
    },
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['sections'], 9);
    assert.equal(payload['ref'], 'abc1234def5678');
    assert.equal(payload['post_status'], 200);
  }

  // Verify the POST path
  assert.equal(postedPath, '/api/almanac/docs/doc-123/outline');

  // Verify the POST body contains the outline
  assert.ok(
    typeof postedBody === 'object' && postedBody !== null,
    'POST body should be an object',
  );
  const body = postedBody as Record<string, unknown>;
  assert.ok(body['outline'], 'POST body should include outline');
  assert.equal(body['ref'], 'abc1234def5678');
});

test('almanac.outline — emits log events at key boundaries', async () => {
  const sink = new MemorySink();
  const ctx = makeCtx({ sink });

  await almanacOutlineHandler(makeJob(), ctx);

  const logs = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e as { type: 'log'; message: string }).message);

  assert.ok(
    logs.some((m) => m.includes('starting')),
    'should log start',
  );
  assert.ok(
    logs.some((m) => m.includes('workspace resolved')),
    'should log workspace resolution',
  );
  assert.ok(
    logs.some((m) => m.includes('prompt')),
    'should log sending prompt',
  );
  assert.ok(
    logs.some((m) => m.includes('done')),
    'should log completion',
  );
});

test('almanac.outline — text-delta events from Claude are piped to sink', async () => {
  const sink = new MemorySink();
  const ctx = makeCtx({ sink });

  await almanacOutlineHandler(makeJob(), ctx);

  const textDeltas = sink.events.filter((e) => e.type === 'text-delta');
  assert.ok(textDeltas.length > 0, 'should have text-delta events in sink');
});

// ────────────────────────────────────────────────────────────────────────────
// Retry on bad JSON
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — retries on malformed JSON, succeeds on second attempt', async () => {
  let callCount = 0;

  const ctx = makeCtx({
    streamClaude: () => {
      callCount++;
      if (callCount === 1) {
        // First call returns broken JSON.
        return textStream('this is not json { broken }');
      }
      // Second call returns valid outline.
      return textStream(makeValidOutlineJson());
    },
  });

  const sink = new MemorySink();
  (ctx as { sink: unknown }).sink = sink;
  ctx.log = (level, message) => {
    sink.emit({ type: 'log', level, message });
  };

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'done', `expected done but got: ${JSON.stringify(result)}`);
  assert.equal(callCount, 2, 'should have called streamClaude twice');

  // Should have logged the retry
  const logs = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e as { type: 'log'; message: string }).message);
  assert.ok(
    logs.some((m) => m.toLowerCase().includes('retry') || m.includes('parse failed')),
    'should log the retry',
  );
});

test('almanac.outline — returns failed if both JSON attempts are invalid', async () => {
  const ctx = makeCtx({
    streamClaude: () => textStream('not json at all!!'),
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /outline JSON invalid after retry/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Validation — missing required sections
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — fails when required sections are missing', async () => {
  // Outline with only 2 of the 9 required sections.
  const incompleteOutline = JSON.stringify({
    product_summary: 'A product.',
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        role: 'required',
        abstract: 'Overview text here for context.',
        subsections: [],
        diagrams_expected: [],
      },
      {
        id: 'architecture',
        title: 'Architecture',
        role: 'required',
        abstract: 'Architecture text here.',
        subsections: [],
        diagrams_expected: [],
      },
    ],
  });

  const sink = new MemorySink();
  const ctx = makeCtx({ sink, streamClaude: () => textStream(incompleteOutline) });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /missing required sections/);
  }

  // Should have emitted a warn log listing the missing sections.
  const warnLogs = sink.events.filter(
    (e) => e.type === 'log' && (e as { type: 'log'; level: string }).level === 'warn',
  );
  assert.ok(warnLogs.length > 0, 'should have warned about missing sections');
});

// ────────────────────────────────────────────────────────────────────────────
// Validation — malformed outline structure
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — fails when outline is missing product_summary', async () => {
  const badOutline = JSON.stringify({
    sections: [
      { id: 'overview', title: 'Overview', role: 'required', abstract: 'x', subsections: [], diagrams_expected: [] },
    ],
  });

  const ctx = makeCtx({ streamClaude: () => textStream(badOutline) });
  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /product_summary/);
  }
});

test('almanac.outline — fails when a section is missing the id field', async () => {
  const badOutline = JSON.stringify({
    product_summary: 'A product.',
    sections: [
      { title: 'Overview', role: 'required', abstract: 'x', subsections: [], diagrams_expected: [] },
    ],
  });

  const ctx = makeCtx({ streamClaude: () => textStream(badOutline) });
  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
});

// ────────────────────────────────────────────────────────────────────────────
// Param validation
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — fails when doc_id param is missing', async () => {
  const ctx = makeCtx();
  const job = makeJob({ doc_id: '' });
  const result = await almanacOutlineHandler(job, ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /doc_id/);
  }
});

test('almanac.outline — fails when repoKey param is missing', async () => {
  const ctx = makeCtx();
  const result = await almanacOutlineHandler(makeJob({ repoKey: undefined }), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /repoKey/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Workspace resolver failure
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — fails when resolveWorkspace throws', async () => {
  const ctx = makeCtx({
    resolveWorkspace: async () => {
      throw new Error('git clone failed: no such host');
    },
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /workspace resolver error/);
    assert.match(result.error, /git clone failed/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Claude stream error
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — fails when Claude stream ends with error', async () => {
  const ctx = makeCtx({
    streamClaude: () =>
      makeClaudeStream([{ type: 'finish', reason: 'error', error: 'claude crashed' }]),
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /error/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Slug normalisation
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — slugifies section ids to URL-safe form', async () => {
  // Outline where Claude used slightly different but valid ids that map via aliases.
  const outlineWithVariants = JSON.stringify({
    product_summary: 'A product.',
    sections: [
      { id: 'overview', title: 'Overview', role: 'required', abstract: 'Overview section.', subsections: [], diagrams_expected: [] },
      { id: 'personas', title: 'Personas', role: 'required', abstract: 'Personas.', subsections: [], diagrams_expected: [] },  // alias → problem-and-personas
      { id: 'features', title: 'Features', role: 'required', abstract: 'Features.', subsections: [], diagrams_expected: [] },  // alias → key-features
      { id: 'journeys', title: 'Journeys', role: 'required', abstract: 'Journeys.', subsections: [], diagrams_expected: [] },  // alias → user-journeys
      { id: 'core_workflows', title: 'Core Workflows', role: 'required', abstract: 'Workflows.', subsections: [], diagrams_expected: [] },  // alias → core-workflows
      { id: 'architecture', title: 'Architecture', role: 'required', abstract: 'How it works.', subsections: [], diagrams_expected: [] },  // alias → how-it-works
      { id: 'integrations', title: 'Integrations', role: 'required', abstract: 'Integrations.', subsections: [], diagrams_expected: [] },
      { id: 'operations', title: 'Operations', role: 'required', abstract: 'Ops.', subsections: [], diagrams_expected: [] },  // alias → configuration-and-operations
      { id: 'engineering', title: 'Engineering', role: 'required', abstract: 'Eng notes.', subsections: [], diagrams_expected: [] },  // alias → engineering-notes
    ],
  });

  const sink = new MemorySink();
  let capturedBody: unknown;

  const ctx = makeCtx({
    sink,
    streamClaude: () => textStream(outlineWithVariants),
    client: async (_path, opts) => {
      capturedBody = opts?.body;
      return {};
    },
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);
  assert.equal(result.status, 'done', `expected done, got: ${JSON.stringify(result)}`);

  // Verify the posted outline has the normalised slugs.
  const body = capturedBody as { outline: { sections: Array<{ id: string }> } };
  const ids = body.outline.sections.map((s) => s.id);
  assert.ok(ids.includes('problem-and-personas'), `expected problem-and-personas in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('key-features'), `expected key-features in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('user-journeys'), `expected user-journeys in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('core-workflows'), `expected core-workflows in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('how-it-works'), `expected how-it-works in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('configuration-and-operations'), `expected configuration-and-operations in ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('engineering-notes'), `expected engineering-notes in ids: ${ids.join(', ')}`);
});

// ────────────────────────────────────────────────────────────────────────────
// POST failure (non-fatal, returns done with post_error)
// ────────────────────────────────────────────────────────────────────────────

test('almanac.outline — returns done even when POST fails (non-fatal)', async () => {
  const ctx = makeCtx({
    client: async () => {
      throw new Error('network timeout');
    },
  });

  const result = await almanacOutlineHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['post_status'], 0);
    assert.ok(typeof payload['post_error'] === 'string');
  }
});
