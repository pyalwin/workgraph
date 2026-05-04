#!/usr/bin/env node
import { login } from "./commands/login.js";
import { status } from "./commands/status.js";
import { run } from "./commands/run.js";
import { logout } from "./commands/logout.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "login":
    await login(rest);
    break;
  case "status":
    await status();
    break;
  case "logout":
    await logout();
    break;
  case "run":
  case undefined:
    await run();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Usage: workgraph [login|status|run|logout]");
    process.exit(1);
}
