import type { JobHandler } from '../dispatcher.js';

/**
 * noopHandler — minimal handler for sanity testing.
 * Emits a log event followed by a finish(stop) event, then returns success.
 */
export const noopHandler: JobHandler = async (_job, ctx) => {
  ctx.sink.emit({ type: 'log', level: 'info', message: '[noop] handler invoked' });
  ctx.sink.emit({ type: 'finish', reason: 'stop' });
  return { status: 'done', payload: { chars: 0 } };
};
