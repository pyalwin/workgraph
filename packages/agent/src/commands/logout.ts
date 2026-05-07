import { deleteConfig, configPath } from '../config.js';

export async function logoutCommand(): Promise<void> {
  await deleteConfig();
  console.log(`Logged out. Credentials removed from ${configPath()}.`);
}
