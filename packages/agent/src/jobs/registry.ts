import type { JobHandler } from "./noop.js";
import { noopHandler } from "./noop.js";

const registry: Record<string, JobHandler> = {
  noop: noopHandler,
};

export function getHandler(kind: string): JobHandler | undefined {
  return registry[kind];
}
