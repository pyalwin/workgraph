/**
 * Tests for the almanac.draft-section handler.
 *
 * Run with: node --test dist/handlers/almanac-draft-section.test.js
 * (build first: npm run build in packages/agent)
 *
 * All external I/O (streamClaude, resolveWorkspace, client) is injected
 * via the ctx object — no real processes are spawned.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { almanacDraftSectionHandler } from './almanac-draft-section.js';
import type { Job, RuntimeEvent } from '../types.js';
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

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const ARCHITECTURE_SECTION = {
  id: 'architecture',
  title: 'Architecture',
  role: 'required' as const,
  abstract: 'Describes the high-level system components and how they interact.',
  subsections: [
    { title: 'Component Overview', abstract: 'List of services and their roles.' },
    { title: 'Data Flow', abstract: 'How data moves through the system.' },
  ],
  diagrams_expected: ['component interaction flowchart', 'data flow diagram'],
};

const STUB_OUTLINE = {
  product_summary: 'A task management platform for engineering teams.',
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      role: 'required' as const,
      abstract: 'High-level product description.',
      subsections: [],
      diagrams_expected: [],
    },
    ARCHITECTURE_SECTION,
    {
      id: 'tech-stack',
      title: 'Tech Stack',
      role: 'required' as const,
      abstract: 'Languages and frameworks.',
      subsections: [],
      diagrams_expected: [],
    },
  ],
};

function makeJob(params: Record<string, unknown> = {}): Job {
  return {
    id: 'test-draft-job-001',
    kind: 'almanac.draft-section',
    params: {
      workspaceId: 'ws-1',
      projectKey: 'my-project',
      repoKey: 'owner/repo',
      ref: 'main',
      doc_id: 'doc-123',
      section_id: 'architecture',
      outline: STUB_OUTLINE,
      ...params,
    },
  };
}

const stubResolveWorkspace: JobContext['resolveWorkspace'] = async () => ({
  path: '/tmp/test-repo',
  sha: 'abc1234def5678',
});

function makeValidMarkdown(section = ARCHITECTURE_SECTION): string {
  return `## ${section.title}

This section describes the architecture of the system.

### Component Overview

The system consists of three main services: \`api-server\`, \`worker\`, and \`db\`. Each runs as a separate Docker container defined in \`docker-compose.yml\`.

\`\`\`mermaid
flowchart TD
  api[API Server] --> db[(PostgreSQL)]
  api --> worker[Background Worker]
  worker --> db
\`\`\`

### Data Flow

Requests enter through the \`api-server\` at \`src/server.ts\`. The server validates the request with \`validateRequest()\` before routing to the appropriate handler.`;
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
    streamClaude: overrides.streamClaude ?? (() => textStream(makeValidMarkdown())),
    client: overrides.client ?? (async () => ({ ok: true })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — happy path returns done with correct payload', async () => {
  const markdown = makeValidMarkdown();
  let postedPath = '';
  let postedBody: unknown;

  const ctx = makeCtx({
    streamClaude: () => textStream(markdown),
    client: async (path, opts) => {
      postedPath = path;
      postedBody = opts?.body;
      return {};
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['chars'], markdown.length);
    assert.equal(payload['ref'], 'abc1234def5678');
    assert.equal(payload['post_status'], 200);
  }

  assert.equal(postedPath, '/api/almanac/docs/doc-123/sections/architecture');
  const body = postedBody as Record<string, unknown>;
  assert.equal(body['markdown'], markdown);
});

test('almanac.draft-section — emits log events at key boundaries', async () => {
  const sink = new MemorySink();
  const ctx = makeCtx({ sink });

  await almanacDraftSectionHandler(makeJob(), ctx);

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
    logs.some((m) => m.includes('sending prompt')),
    'should log sending prompt',
  );
  assert.ok(
    logs.some((m) => m.includes('done')),
    'should log completion',
  );
});

test('almanac.draft-section — text-delta events from Claude are piped to sink', async () => {
  const sink = new MemorySink();
  const ctx = makeCtx({ sink });

  await almanacDraftSectionHandler(makeJob(), ctx);

  const textDeltas = sink.events.filter((e) => e.type === 'text-delta');
  assert.ok(textDeltas.length > 0, 'should have text-delta events in sink');
});

// ────────────────────────────────────────────────────────────────────────────
// Retry on empty/invalid output
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — retries when output is empty, succeeds on second attempt', async () => {
  let callCount = 0;
  const markdown = makeValidMarkdown();

  const sink = new MemorySink();
  const ctx = makeCtx({
    sink,
    streamClaude: () => {
      callCount++;
      if (callCount === 1) {
        return textStream('');  // empty first response
      }
      return textStream(markdown);
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done', `expected done but got: ${JSON.stringify(result)}`);
  // 1 draft + 1 retry + 1 polish (architecture section is not engineering-notes,
  // so it goes through the polish pass after a successful retry).
  assert.equal(callCount, 3, 'should have called streamClaude three times (draft + retry + polish)');

  const logs = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e as { type: 'log'; message: string }).message);
  assert.ok(
    logs.some((m) => m.toLowerCase().includes('retry') || m.includes('empty')),
    'should log the retry',
  );
});

test('almanac.draft-section — retries when output does not start with ## <title>', async () => {
  let callCount = 0;
  const markdown = makeValidMarkdown();

  const ctx = makeCtx({
    streamClaude: () => {
      callCount++;
      if (callCount === 1) {
        // Output starts with the wrong heading.
        return textStream('# Wrong heading\n\nSome content here.');
      }
      return textStream(markdown);
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done', `expected done but got: ${JSON.stringify(result)}`);
  // 1 draft + 1 retry + 1 polish (architecture section is not engineering-notes,
  // so it goes through the polish pass after a successful retry).
  assert.equal(callCount, 3, 'should have called streamClaude three times (draft + retry + polish)');
});

test('almanac.draft-section — returns failed when both attempts produce invalid output', async () => {
  const ctx = makeCtx({
    streamClaude: () => textStream('No heading here. Just prose.'),
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /invalid after retry/);
  }
});

test('almanac.draft-section — returns failed when both attempts produce empty output', async () => {
  const ctx = makeCtx({
    streamClaude: () => textStream(''),
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /invalid after retry/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Param validation
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — fails when section_id is missing', async () => {
  const ctx = makeCtx();
  const result = await almanacDraftSectionHandler(makeJob({ section_id: '' }), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /section_id/);
  }
});

test('almanac.draft-section — fails when doc_id is missing', async () => {
  const ctx = makeCtx();
  const result = await almanacDraftSectionHandler(makeJob({ doc_id: undefined }), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /doc_id/);
  }
});

test('almanac.draft-section — fails when outline is not provided', async () => {
  const ctx = makeCtx();
  const result = await almanacDraftSectionHandler(makeJob({ outline: null }), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /outline/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Section not found in outline
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — fails when section_id is not in outline', async () => {
  const ctx = makeCtx();
  const result = await almanacDraftSectionHandler(
    makeJob({ section_id: 'nonexistent-section' }),
    ctx,
  );

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /not found in outline/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Workspace resolver failure
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — fails when resolveWorkspace throws', async () => {
  const ctx = makeCtx({
    resolveWorkspace: async () => {
      throw new Error('git fetch failed: authentication required');
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /workspace resolver error/);
    assert.match(result.error, /authentication required/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Claude stream error
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — fails when Claude stream ends with error', async () => {
  const ctx = makeCtx({
    streamClaude: () =>
      makeClaudeStream([{ type: 'finish', reason: 'error', error: 'claude crashed' }]),
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /error/);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST failure (non-fatal)
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — returns done even when POST fails (non-fatal)', async () => {
  const markdown = makeValidMarkdown();
  const ctx = makeCtx({
    streamClaude: () => textStream(markdown),
    client: async () => {
      throw new Error('connection refused');
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['post_status'], 0);
    assert.ok(typeof payload['post_error'] === 'string');
    assert.equal(payload['chars'], markdown.length);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-section context
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — prompt includes cross-section context (smoke check)', async () => {
  // We can verify the prompt is rich by checking what was passed to streamClaude.
  // Capture only the first call's prompt — subsequent calls (e.g. the
  // polish pass) reuse streamClaude with a different prompt.
  let capturedPrompt = '';

  const ctx = makeCtx({
    streamClaude: (opts) => {
      if (!capturedPrompt) capturedPrompt = opts.prompt;
      return textStream(makeValidMarkdown());
    },
  });

  await almanacDraftSectionHandler(makeJob(), ctx);

  // The prompt should mention the other sections (overview, tech-stack) for cross-context.
  assert.ok(
    capturedPrompt.includes('Overview') || capturedPrompt.includes('overview'),
    'prompt should mention other section for cross-context',
  );
  assert.ok(
    capturedPrompt.includes('Architecture'),
    'prompt should mention the target section title',
  );
  // The prompt should include the product summary.
  assert.ok(
    capturedPrompt.includes('task management platform'),
    'prompt should include product summary',
  );
});

test('almanac.draft-section — prompt includes diagram instructions', async () => {
  // Capture only the first call's prompt — subsequent calls (e.g. the
  // polish pass) reuse streamClaude with a different prompt.
  let capturedPrompt = '';

  const ctx = makeCtx({
    streamClaude: (opts) => {
      if (!capturedPrompt) capturedPrompt = opts.prompt;
      return textStream(makeValidMarkdown());
    },
  });

  await almanacDraftSectionHandler(makeJob(), ctx);

  // The architecture section has diagrams_expected: ['component interaction flowchart', 'data flow diagram']
  assert.ok(
    capturedPrompt.includes('component interaction flowchart'),
    'prompt should include expected diagram descriptions',
  );
  assert.ok(
    capturedPrompt.includes('mermaid'),
    'prompt should mention mermaid',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Section with no diagrams or subsections
// ────────────────────────────────────────────────────────────────────────────

test('almanac.draft-section — runs polish pass with no tools for non-appendix sections', async () => {
  const draft = makeValidMarkdown();
  const polished = `## ${ARCHITECTURE_SECTION.title}\n\nPolished prose only.`;
  const calls: Array<{ allowed: string[] | undefined; disallowed: string[] | undefined; promptStart: string }> = [];

  const ctx = makeCtx({
    streamClaude: (opts) => {
      calls.push({
        allowed: opts.allowedTools,
        disallowed: opts.disallowedTools,
        promptStart: opts.prompt.slice(0, 80),
      });
      // 1st call → draft, 2nd call → polish output.
      return calls.length === 1 ? textStream(draft) : textStream(polished);
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  assert.equal(calls.length, 2, 'expected draft + polish call');
  // First call has the normal allowed tool set.
  assert.deepEqual(calls[0].allowed, ['Read', 'Grep', 'Glob', 'Bash']);
  // Polish call has no tools.
  assert.deepEqual(calls[1].allowed, []);
  // The polish output should be persisted (POSTed) instead of the draft.
});

test('almanac.draft-section — falls back to draft when polish output is invalid', async () => {
  const draft = makeValidMarkdown();
  let postedMarkdown: string | undefined;
  let callCount = 0;

  const ctx = makeCtx({
    streamClaude: () => {
      callCount++;
      // 1st call → valid draft, 2nd call (polish) → garbage that doesn't start with `## <title>`.
      return callCount === 1 ? textStream(draft) : textStream('not a section');
    },
    client: async (_path, opts) => {
      postedMarkdown = (opts?.body as { markdown: string }).markdown;
      return {};
    },
  });

  const result = await almanacDraftSectionHandler(makeJob(), ctx);

  assert.equal(result.status, 'done');
  assert.equal(postedMarkdown, draft, 'should keep the original draft when polish fails');
});

test('almanac.draft-section — skips polish pass for engineering-notes', async () => {
  const engNotesSection = {
    id: 'engineering-notes',
    title: 'Engineering Notes',
    role: 'required' as const,
    abstract: 'Engineering appendix.',
    subsections: [],
    diagrams_expected: [],
  };
  const outline = {
    product_summary: 'A platform.',
    sections: [engNotesSection],
  };
  const md = `## Engineering Notes\n\nDirect citation is fine here. See \`src/lib/foo.ts\`.`;
  let callCount = 0;
  const ctx = makeCtx({
    streamClaude: () => {
      callCount++;
      return textStream(md);
    },
  });

  const result = await almanacDraftSectionHandler(
    makeJob({ section_id: 'engineering-notes', outline }),
    ctx,
  );

  assert.equal(result.status, 'done');
  assert.equal(callCount, 1, 'engineering-notes should skip the polish pass (single call only)');
});

test('almanac.draft-section — works for a section with empty diagrams_expected and subsections', async () => {
  const outlineWithMinimalSection = {
    product_summary: 'A product.',
    sections: [
      {
        id: 'configuration',
        title: 'Configuration',
        role: 'required' as const,
        abstract: 'How to configure the application.',
        subsections: [],
        diagrams_expected: [],
      },
    ],
  };

  const markdown = '## Configuration\n\nConfiguration is managed via environment variables defined in `.env`.';
  const ctx = makeCtx({
    streamClaude: () => textStream(markdown),
  });

  const result = await almanacDraftSectionHandler(
    makeJob({
      section_id: 'configuration',
      outline: outlineWithMinimalSection,
    }),
    ctx,
  );

  assert.equal(result.status, 'done');
  if (result.status === 'done') {
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload['chars'], markdown.length);
  }
});
