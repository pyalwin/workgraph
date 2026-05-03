import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface AgentConfig {
  url: string;
  agent_id: string;
  agent_token: string;
  paired_at: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".workgraph");
const CONFIG_PATH = path.join(CONFIG_DIR, "agent.json");

export async function readConfig(): Promise<AgentConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(config: AgentConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_PATH);
  } catch {
    // already gone — no-op
  }
}

export const CONFIG_PATH_DISPLAY = CONFIG_PATH;
