import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.workgraph');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export async function readConfig(): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as AgentConfig;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeConfig(config: AgentConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const json = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_PATH, json, { encoding: 'utf8', mode: 0o600 });
}

export async function deleteConfig(): Promise<void> {
  try {
    await unlink(CONFIG_PATH);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return;
    throw err;
  }
}

export function configPath(): string {
  return CONFIG_PATH;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
