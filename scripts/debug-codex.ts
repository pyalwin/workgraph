/**
 * Debug script: spawn Codex with the same args the agent uses and dump
 * everything (stdout, stderr, exit code, full raw bytes) so we can see
 * exactly what Codex is producing.
 *
 * Run: npx tsx scripts/debug-codex.ts
 */
import { spawn } from "node:child_process";

const PROMPT = `Output exactly one JSON object per line. No markdown.
Example output:
{ "sha": "abc1234567890abcdef1234567890abcdef12345", "intent": "fix", "architectural_significance": "low", "is_feature_evolution": false }

For this commit:
sha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
message: fix typo in README
files: README.md`;

async function main() {
  const args = ["exec", "--json", "--sandbox", "read-only", PROMPT];
  console.log(`spawning: codex ${args.slice(0, 4).join(" ")} <prompt of ${PROMPT.length} chars>`);
  console.log("---");

  const child = spawn("codex", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    process.stdout.write(`[STDOUT] ${s}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    process.stderr.write(`[STDERR] ${s}`);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  console.log("\n---");
  console.log(`Exit code: ${exitCode}`);
  console.log(`stdout total: ${stdout.length} bytes`);
  console.log(`stderr total: ${stderr.length} bytes`);
  if (stdout.length === 0) {
    console.log("\n✗ Codex produced ZERO stdout. Possible causes:");
    console.log("  - Codex isn't authenticated (run `codex login` once)");
    console.log("  - Wrong Codex version — try `codex --version`");
    console.log("  - --sandbox read-only flag rejected by your install");
    console.log("\nTry running this verbatim in your terminal to see what happens:");
    console.log(`  codex exec --json --sandbox read-only 'say hello in JSON'`);
  } else {
    console.log("\n✓ Codex produced stdout. Above output should contain JSON events.");
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
