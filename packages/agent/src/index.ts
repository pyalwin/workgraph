#!/usr/bin/env node

/**
 * workgraph — CLI entry point.
 * Dispatches to subcommands based on argv[2].
 */

export {}; // mark this file as an ES module so top-level await is allowed

const [, , command, ...rest] = process.argv;

switch (command) {
  case 'login': {
    const { loginCommand } = await import('./commands/login.js');
    await loginCommand(rest);
    break;
  }
  case 'status': {
    const { statusCommand } = await import('./commands/status.js');
    await statusCommand();
    break;
  }
  case 'logout': {
    const { logoutCommand } = await import('./commands/logout.js');
    await logoutCommand();
    break;
  }
  case 'run': {
    const { runCommand } = await import('./commands/run.js');
    await runCommand();
    break;
  }
  case 'repo': {
    const { repoCommand } = await import('./commands/repo.js');
    await repoCommand(rest);
    break;
  }
  case 'service': {
    const { serviceCommand } = await import('./commands/service.js');
    await serviceCommand(rest);
    break;
  }
  default: {
    const name = command ? `Unknown command: ${command}\n\n` : '';
    console.error(`${name}Usage: workgraph <command>

Commands:
  login [--url <server>] [--dev]   Pair this machine with your Workgraph workspace
                                   (defaults to https://workgraph-beta.vercel.app;
                                    --dev pairs with http://localhost:3000;
                                    WORKGRAPH_SERVER_URL env var also accepted)
  status                           Show pairing status and verify token
  logout                           Remove local credentials
  run                              Start polling for jobs (foreground)
  service install                  Install as a background service so the agent
                                   auto-starts at login (macOS LaunchAgent /
                                   Linux systemd --user). No terminal needed.
  service uninstall                Stop and remove the background service.
  service status                   Show whether the background service is running.
  service logs                     Tail recent service log output.
  repo add <owner/name> <path>     Map a local repo path (skips auto-clone)
  repo list                        Show mapped repos
  repo remove <owner/name>         Remove a repo mapping
`);
    process.exit(command ? 1 : 0);
  }
}
