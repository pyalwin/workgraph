import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter } from 'node:path';
import type { Readable } from 'node:stream';

const availabilityCache = new Map<string, boolean>();

/** Cached check for a binary on PATH. */
export async function isOnPath(bin: string): Promise<boolean> {
  if (availabilityCache.has(bin)) return availabilityCache.get(bin)!;
  const path = process.env.PATH || '';
  const dirs = path.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try {
      await access(`${d}/${bin}`, constants.X_OK);
      availabilityCache.set(bin, true);
      return true;
    } catch {
      // try next
    }
  }
  availabilityCache.set(bin, false);
  return false;
}

/**
 * Spawn a CLI and return an async generator of stdout lines (line-delimited JSON).
 * Errors on stderr are buffered and surfaced in the close handler.
 */
export async function* spawnCliLines(
  command: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): AsyncGenerator<string, { exitCode: number; stderr: string }, void> {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = child.stdout as Readable;
  const stderrStream = child.stderr as Readable;

  let stderr = '';
  stderrStream.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const onAbort = () => child.kill('SIGTERM');
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  try {
    for await (const chunk of stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  const exitCode: number = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code ?? 0));
  });

  return { exitCode, stderr };
}

/** Best-effort JSON parse. Returns null on failure. */
export function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
