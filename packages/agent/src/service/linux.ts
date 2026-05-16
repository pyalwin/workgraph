/**
 * Linux systemd --user installer.
 *
 * Writes a user-scoped unit to ~/.config/systemd/user/workgraph-agent.service
 * with Restart=always and enables it via `systemctl --user enable --now`.
 * No root required — runs as the logged-in user.
 *
 * Logs are captured by journald; readable via `journalctl --user -u workgraph-agent`.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceInstaller, ServiceStatus } from './types.js';

const UNIT_NAME = 'workgraph-agent.service';
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME);

function unitFile(opts: { nodePath: string; binaryPath: string }): string {
  return `[Unit]
Description=Workgraph local agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.binaryPath} run
Restart=always
RestartSec=5
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
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

export const linuxInstaller: ServiceInstaller = {
  unitPath: UNIT_PATH,
  logsPath: '(journalctl --user -u workgraph-agent)',

  async install({ binaryPath, nodePath }) {
    await mkdir(UNIT_DIR, { recursive: true });
    await writeFile(UNIT_PATH, unitFile({ binaryPath, nodePath }), 'utf8');

    const reload = await runCmd('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
    }
    const enable = await runCmd('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    if (enable.code !== 0) {
      throw new Error(`systemctl --user enable --now ${UNIT_NAME} failed: ${enable.stderr.trim()}`);
    }
  },

  async uninstall() {
    await runCmd('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
    try {
      await unlink(UNIT_PATH);
    } catch {
      /* unit file may not exist — fine */
    }
    await runCmd('systemctl', ['--user', 'daemon-reload']);
  },

  async status(): Promise<ServiceStatus> {
    let installed = false;
    try {
      await access(UNIT_PATH);
      installed = true;
    } catch { /* not installed */ }
    if (!installed) return { installed: false, running: false, note: 'not installed' };

    const isActive = await runCmd('systemctl', ['--user', 'is-active', UNIT_NAME]);
    const running = isActive.stdout.trim() === 'active';
    // Best-effort pid lookup.
    let pid: number | undefined;
    const show = await runCmd('systemctl', ['--user', 'show', '-p', 'MainPID', UNIT_NAME]);
    const m = show.stdout.match(/MainPID=(\d+)/);
    if (m && Number(m[1]) > 0) pid = Number(m[1]);

    return {
      installed: true,
      running,
      pid,
      note: isActive.stdout.trim() || 'unknown',
    };
  },
};
