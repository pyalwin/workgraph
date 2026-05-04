import { readConfig } from "../config.js";

export async function status(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.log("Not paired");
  } else {
    console.log(`Connected to ${config.url} as ${config.agent_id}`);
  }
}
