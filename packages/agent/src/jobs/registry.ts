import type { JobHandler } from "./noop.js";
import { noopHandler } from "./noop.js";
import { almanacCodeEventsExtractHandler } from "./almanac-code-events-extract.js";
import { almanacFileLifecycleExtractHandler } from "./almanac-file-lifecycle-extract.js";
import { almanacNoiseClassifyHandler } from "./almanac-noise-classify.js";

const registry: Record<string, JobHandler> = {
  noop: noopHandler,
  "almanac.code-events.extract": almanacCodeEventsExtractHandler,
  "almanac.file-lifecycle.extract": almanacFileLifecycleExtractHandler,
  "almanac.noise.classify": almanacNoiseClassifyHandler,
};

export function getHandler(kind: string): JobHandler | undefined {
  return registry[kind];
}
