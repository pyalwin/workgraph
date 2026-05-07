/**
 * Canned-fixture tests for the Claude driver's event translation logic.
 *
 * Run with: node --test dist/drivers/claude.test.js
 * (build first: npm run build in packages/agent)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateEvent } from './claude.js';

// ────────────────────────────────────────────────────────────────────────────
// Canned fixtures (representative Claude stream-json lines)
// ────────────────────────────────────────────────────────────────────────────

const FIXTURE_SYSTEM_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'abc-123-def-456',
};

const FIXTURE_TEXT_DELTA = {
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello, world!' },
  },
};

const FIXTURE_TOOL_USE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'read_file',
        input: { path: '/src/index.ts' },
      },
    ],
  },
};

const FIXTURE_TOOL_RESULT_STRING = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01',
        content: 'export function main() {}',
      },
    ],
  },
};

const FIXTURE_TOOL_RESULT_ARRAY = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02',
        content: [
          { type: 'text', text: 'line one\n' },
          { type: 'text', text: 'line two\n' },
        ],
      },
    ],
  },
};

const FIXTURE_RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  result: 'The file exports a main function.',
  usage: { input_tokens: 120, output_tokens: 40, cost_usd: 0.0003 },
};

const FIXTURE_RESULT_ERROR = {
  type: 'result',
  subtype: 'error',
  error: 'claude: command not found',
  usage: null,
};

const FIXTURE_RESULT_CANCELLED = {
  type: 'result',
  subtype: 'cancelled',
};

const FIXTURE_UNKNOWN = { type: 'something_new', data: 42 };

const FIXTURE_NON_TEXT_DELTA = {
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('system.init → log event containing session_id, calls onSessionId callback', () => {
  let captured: string | undefined;
  const events = translateEvent(FIXTURE_SYSTEM_INIT, (id) => { captured = id; });

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'log');
  if (ev.type === 'log') {
    assert.equal(ev.level, 'info');
    assert.match(ev.message, /abc-123-def-456/);
  }
  assert.equal(captured, 'abc-123-def-456');
});

test('text delta → text-delta event', () => {
  const events = translateEvent(FIXTURE_TEXT_DELTA);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'text-delta');
  if (ev.type === 'text-delta') {
    assert.equal(ev.text, 'Hello, world!');
  }
});

test('assistant tool_use block → tool-call event', () => {
  const events = translateEvent(FIXTURE_TOOL_USE);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'tool-call');
  if (ev.type === 'tool-call') {
    assert.equal(ev.tool, 'read_file');
    assert.equal(ev.call_id, 'toolu_01');
    assert.deepEqual(ev.args, { path: '/src/index.ts' });
  }
});

test('user tool_result with string content → tool-result event', () => {
  const events = translateEvent(FIXTURE_TOOL_RESULT_STRING);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'tool-result');
  if (ev.type === 'tool-result') {
    assert.equal(ev.call_id, 'toolu_01');
    assert.equal(ev.output, 'export function main() {}');
  }
});

test('user tool_result with array content → tool-result with concatenated text', () => {
  const events = translateEvent(FIXTURE_TOOL_RESULT_ARRAY);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'tool-result');
  if (ev.type === 'tool-result') {
    assert.equal(ev.call_id, 'toolu_02');
    assert.equal(ev.output, 'line one\nline two\n');
  }
});

test('result success → usage event then finish(stop)', () => {
  const events = translateEvent(FIXTURE_RESULT_SUCCESS);
  assert.equal(events.length, 2);

  const usageEv = events[0];
  assert.equal(usageEv.type, 'usage');
  if (usageEv.type === 'usage') {
    assert.equal(usageEv.input_tokens, 120);
    assert.equal(usageEv.output_tokens, 40);
    assert.equal(usageEv.cost_usd, 0.0003);
  }

  const finishEv = events[1];
  assert.equal(finishEv.type, 'finish');
  if (finishEv.type === 'finish') {
    assert.equal(finishEv.reason, 'stop');
    assert.equal(finishEv.final_text, 'The file exports a main function.');
    assert.equal(finishEv.error, undefined);
  }
});

test('result error (null usage) → finish(error) only, no usage event', () => {
  const events = translateEvent(FIXTURE_RESULT_ERROR);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'finish');
  if (ev.type === 'finish') {
    assert.equal(ev.reason, 'error');
    assert.equal(ev.error, 'claude: command not found');
  }
});

test('result cancelled → finish(cancelled)', () => {
  const events = translateEvent(FIXTURE_RESULT_CANCELLED);
  // No usage, just finish.
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'finish');
  if (ev.type === 'finish') {
    assert.equal(ev.reason, 'cancelled');
  }
});

test('unknown event type → empty array', () => {
  assert.deepEqual(translateEvent(FIXTURE_UNKNOWN), []);
});

test('non-text stream_event delta → empty array', () => {
  assert.deepEqual(translateEvent(FIXTURE_NON_TEXT_DELTA), []);
});

test('non-object inputs → empty array', () => {
  assert.deepEqual(translateEvent(null), []);
  assert.deepEqual(translateEvent(42), []);
  assert.deepEqual(translateEvent('raw string'), []);
  assert.deepEqual(translateEvent([1, 2, 3]), []);
});

test('assistant message with multiple tool_use blocks → one tool-call per block', () => {
  const fixture = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'toolu_b', name: 'write_file', input: { path: 'b.ts', content: '' } },
      ],
    },
  };
  const events = translateEvent(fixture);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'tool-call');
  assert.equal(events[1].type, 'tool-call');
  if (events[0].type === 'tool-call') assert.equal(events[0].call_id, 'toolu_a');
  if (events[1].type === 'tool-call') assert.equal(events[1].call_id, 'toolu_b');
});

test('result success with no usage → only finish event', () => {
  const fixture = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    // no usage field
  };
  const events = translateEvent(fixture);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'finish');
  if (events[0].type === 'finish') {
    assert.equal(events[0].reason, 'stop');
    assert.equal(events[0].final_text, 'done');
  }
});
