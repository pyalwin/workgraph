/**
 * `workgraph service <install|uninstall|status|logs>`
 *
 * Installs the agent as a background service on macOS (LaunchAgent) or
 * Linux (systemd --user) so users don't have to keep a terminal open
 * running `workgraph run`.
 */
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getInstaller } from '../service/index.js';

function unsupportedPlatformMessage(): string {
  return `Background-service install is not yet supported on ${process.platform}.
You can keep the agent running in a terminal with:
  workgraph run

Or use your OS's task scheduler to run the same command at login.`;
}

function resolveBinaryPath(): string {
  // process.argv[1] is the running CLI binary. Resolve any symlinks (npm
  // global installs typically link `workgraph` → ../@workgraph/agent/dist/index.js).
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

function resolveNodePath(): string {
  return process.execPath; // absolute path to the node binary that's running us
}

async function tailFile(path: string, lines: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('tail', ['-n', String(lines), path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.on('close', () => resolve(stdout));
    child.on('error', () => resolve(''));
  });
}

export async function serviceCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const installer = getInstaller();

  if (!installer) {
    console.error(unsupportedPlatformMessage());
    process.exit(1);
  }

  switch (sub) {
    case 'install': {
      const binaryPath = resolveBinaryPath();
      const nodePath = resolveNodePath();
      console.log(`Installing background service...`);
      console.log(`  binary: ${binaryPath}`);
      console.log(`  node:   ${nodePath}`);
      console.log(`  unit:   ${installer.unitPath}`);
      try {
        await installer.install({ binaryPath, nodePath });
        console.log(`\n✓ Installed and started. Logs: ${installer.logsPath}`);
        console.log(`  Stop:    workgraph service uninstall`);
        console.log(`  Status:  workgraph service status`);
      } catch (err) {
        console.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case 'uninstall': {
      try {
        await installer.uninstall();
        console.log(`✓ Service stopped and unit file removed.`);
      } catch (err) {
        console.error(`Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case 'status': {
      const s = await installer.status();
      console.log(`Installed: ${s.installed ? 'yes' : 'no'}`);
      console.log(`Running:   ${s.running ? 'yes' : 'no'}`);
      if (s.pid) console.log(`PID:       ${s.pid}`);
      if (s.note) console.log(`State:     ${s.note}`);
      if (s.installed) console.log(`Unit path: ${installer.unitPath}`);
      if (s.installed) console.log(`Logs:      ${installer.logsPath}`);
      break;
    }
    case 'logs': {
      if (process.platform === 'darwin') {
        const text = await tailFile(installer.logsPath, 80);
        if (text.trim()) {
          process.stdout.write(text);
        } else {
          console.log(`No logs yet at ${installer.logsPath}`);
        }
      } else if (process.platform === 'linux') {
        // Delegate to journalctl which streams the user-unit logs cleanly.
        const child = spawn('journalctl', ['--user', '-u', 'workgraph-agent', '-n', '80', '--no-pager'], {
          stdio: 'inherit',
        });
        await new Promise<void>((resolve) => child.on('close', () => resolve()));
      }
      break;
    }
    default: {
      console.error(`Usage: workgraph service <install|uninstall|status|logs>

  install      Register the agent as a background service that auto-starts
               at login and auto-restarts on crash. Runs as the current user.
               (macOS LaunchAgent / Linux systemd user unit)

  uninstall    Stop the service and remove the unit file.

  status       Show whether the service is installed and running.

  logs         Tail recent agent log output.`);
      process.exit(sub ? 1 : 0);
    }
  }
}
