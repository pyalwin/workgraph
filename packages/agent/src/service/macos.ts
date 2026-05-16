/**
 * macOS LaunchAgent installer.
 *
 * Writes a LaunchAgent plist to ~/Library/LaunchAgents/com.workgraph.agent.plist
 * with KeepAlive=true + RunAtLoad=true so the agent auto-starts at login
 * AND auto-restarts if it crashes. Loaded via `launchctl bootstrap`
 * (preferred on macOS 10.10+; falls back to `launchctl load` on older).
 *
 * Logs land in ~/Library/Logs/workgraph/agent.{log,err}.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceInstaller, ServiceStatus } from './types.js';

const LABEL = 'com.workgraph.agent';
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOGS_DIR = join(homedir(), 'Library', 'Logs', 'workgraph');
const LOG_PATH = join(LOGS_DIR, 'agent.log');
const ERR_PATH = join(LOGS_DIR, 'agent.err');

function plistXml(opts: { nodePath: string; binaryPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.nodePath}</string>
        <string>${opts.binaryPath}</string>
        <string>run</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>

    <key>StandardErrorPath</key>
    <string>${ERR_PATH}</string>

    <key>ProcessType</key>
    <string>Background</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
`;
}

function runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function getDomainTarget(): Promise<string> {
  return `gui/${process.getuid?.() ?? ''}`;
}

export const macosInstaller: ServiceInstaller = {
  unitPath: PLIST_PATH,
  logsPath: LOG_PATH,

  async install({ binaryPath, nodePath }) {
    await mkdir(PLIST_DIR, { recursive: true });
    await mkdir(LOGS_DIR, { recursive: true });
    await writeFile(PLIST_PATH, plistXml({ binaryPath, nodePath }), 'utf8');

    const domain = await getDomainTarget();
    // Bootout first (idempotent) — if we leave a stale entry loaded, bootstrap fails.
    await runCmd('launchctl', ['bootout', `${domain}/${LABEL}`]);
    const boot = await runCmd('launchctl', ['bootstrap', domain, PLIST_PATH]);
    if (boot.code !== 0) {
      // Fallback for older macOS that doesn't support bootstrap subcommand.
      const load = await runCmd('launchctl', ['load', '-w', PLIST_PATH]);
      if (load.code !== 0) {
        throw new Error(
          `launchctl bootstrap failed (${boot.stderr.trim()}) and load fallback also failed (${load.stderr.trim()})`,
        );
      }
    }
    // Kick it now too — bootstrap with RunAtLoad usually starts it, but
    // kickstart guarantees the process is actually running before we return.
    await runCmd('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  },

  async uninstall() {
    const domain = await getDomainTarget();
    await runCmd('launchctl', ['bootout', `${domain}/${LABEL}`]);
    // Older fallback for symmetry with install.
    await runCmd('launchctl', ['unload', PLIST_PATH]);
    try {
      await unlink(PLIST_PATH);
    } catch {
      /* file may not exist — that's fine */
    }
  },

  async status(): Promise<ServiceStatus> {
    let installed = false;
    try {
      await access(PLIST_PATH);
      installed = true;
    } catch { /* not installed */ }

    if (!installed) return { installed: false, running: false, note: 'not installed' };

    const domain = await getDomainTarget();
    const list = await runCmd('launchctl', ['print', `${domain}/${LABEL}`]);
    if (list.code !== 0) {
      return { installed: true, running: false, note: 'loaded plist but launchctl reports not running' };
    }
    // Try to extract a pid from the print output.
    const pidMatch = list.stdout.match(/pid\s*=\s*(\d+)/i);
    const stateMatch = list.stdout.match(/state\s*=\s*(\S+)/i);
    const running = !!pidMatch && stateMatch?.[1]?.toLowerCase() === 'running';
    return {
      installed: true,
      running,
      pid: pidMatch ? Number(pidMatch[1]) : undefined,
      note: stateMatch?.[1] ?? (running ? 'running' : 'unknown'),
    };
  },
};

export function macosLogsExist(): boolean {
  return existsSync(LOG_PATH);
}
