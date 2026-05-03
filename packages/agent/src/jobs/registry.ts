import type { JobHandler } from "./noop.js";
import { noopHandler } from "./noop.js";
import { almanacCodeEventsExtractHandler } from "./almanac-code-events-extract.js";

const registry: Record<string, JobHandler> = {
  noop: noopHandler,
  "almanac.code-events.extract": almanacCodeEventsExtractHandler,
};

export function getHandler(kind: string): JobHandler | undefined {
  return registry[kind];
}
