/**
 * handlers/index.ts — register all custom job handlers.
 *
 * Call registerAllHandlers() once near the top of the run command,
 * before the poll loop starts. This populates the dispatcher registry
 * with the handlers defined in this package.
 *
 * The built-in 'noop' handler is registered by dispatcher.ts at module
 * load time and is NOT repeated here.
 */

import { registerHandler } from '../dispatcher.js';
import { almanacOutlineHandler } from './almanac-outline.js';
import { almanacDraftSectionHandler } from './almanac-draft-section.js';
import { almanacBacklogHandler } from './almanac-backlog.js';

export function registerAllHandlers(): void {
  registerHandler('almanac.outline', almanacOutlineHandler);
  registerHandler('almanac.draft-section', almanacDraftSectionHandler);
  registerHandler('almanac.backlog', almanacBacklogHandler);
}
