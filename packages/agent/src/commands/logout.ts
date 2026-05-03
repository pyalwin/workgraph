import { deleteConfig } from "../config.js";

export async function logout(): Promise<void> {
  await deleteConfig();
  // v1: no server-side revoke — see README for details
  console.log("Logged out. Config removed.");
}
