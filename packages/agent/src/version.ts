/**
 * Resolves the agent version from package.json at runtime so the
 * heartbeat and status command always report whatever was published —
 * not a hardcoded constant that drifts.
 *
 * Reads `dist/../package.json` relative to this file's URL so it works
 * for both `node dist/...` (published) and `tsx src/...` (dev).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface PackageJson {
  version?: string;
  name?: string;
}

let cached: string | null = null;

export function agentVersion(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // From `dist/version.js` → `dist/../package.json`.
    // From `src/version.ts` (tsx) → `src/../package.json`.
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as PackageJson;
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const AGENT_VERSION = agentVersion();
