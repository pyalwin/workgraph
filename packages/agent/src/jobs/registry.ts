import type { JobHandler } from "./noop.js";
import { noopHandler } from "./noop.js";
import { almanacCodeEventsExtractHandler } from "./almanac-code-events-extract.js";
import { almanacFileLifecycleExtractHandler } from "./almanac-file-lifecycle-extract.js";
import { almanacNoiseClassifyHandler } from "./almanac-noise-classify.js";
import { almanacUnitsNameHandler } from "./almanac-units-name.js";
import { almanacUnitsClusterHandler } from "./almanac-units-cluster.js";

const registry: Record<string, JobHandler> = {
  noop: noopHandler,
  "almanac.code-events.extract": almanacCodeEventsExtractHandler,
  "almanac.file-lifecycle.extract": almanacFileLifecycleExtractHandler,
  "almanac.noise.classify": almanacNoiseClassifyHandler,
  "almanac.units.name": almanacUnitsNameHandler,
  "almanac.units.cluster": almanacUnitsClusterHandler,
};

export function getHandler(kind: string): JobHandler | undefined {
  return registry[kind];
}
