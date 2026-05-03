import { apiFetchPublic } from "../client.js";
import { writeConfig } from "../config.js";

interface StartResponse {
  pairing_id: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
}

interface PollResponse {
  status: "pending" | "confirmed" | "expired" | "consumed";
  agent_id?: string;
  agent_token?: string;
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_URL = process.env["WORKGRAPH_URL"] ?? "http://localhost:3000";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(args: string[]): Promise<void> {
  const urlFlagIdx = args.indexOf("--url");
  const baseUrl =
    urlFlagIdx !== -1 && args[urlFlagIdx + 1]
      ? args[urlFlagIdx + 1]!
      : DEFAULT_URL;

  let startData: StartResponse;
  try {
    startData = (await apiFetchPublic(baseUrl, "/api/agent/pair/start", {
      method: "POST",
    })) as StartResponse;
  } catch (err) {
    console.error(
      "Login failed:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }

  const { pairing_id, user_code, verification_url, expires_in } = startData;

  console.log("\nOpen this URL in your browser:");
  console.log(`  ${verification_url}`);
  console.log(`And enter this code: ${user_code}\n`);

  const deadline = Date.now() + expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollData: PollResponse;
    try {
      pollData = (await apiFetchPublic(baseUrl, "/api/agent/pair/poll", {
        method: "POST",
        body: { pairing_id },
      })) as PollResponse;
    } catch (err) {
      // transient network error — keep trying until deadline
      console.error(
        "Poll error (retrying):",
        err instanceof Error ? err.message : String(err)
      );
      continue;
    }

    if (pollData.status === "pending") {
      continue;
    }

    if (pollData.status === "confirmed") {
      if (!pollData.agent_id || !pollData.agent_token) {
        console.error("Server confirmed pairing but returned incomplete data.");
        process.exit(1);
      }
      await writeConfig({
        url: baseUrl,
        agent_id: pollData.agent_id,
        agent_token: pollData.agent_token,
        paired_at: new Date().toISOString(),
      });
      console.log(`Paired ✓ as ${pollData.agent_id}`);
      return;
    }

    // expired or consumed
    console.error(`Pairing failed: ${pollData.status}. Run \`workgraph login\` to try again.`);
    process.exit(1);
  }

  console.error("Pairing timed out. Run `workgraph login` to try again.");
  process.exit(1);
}
