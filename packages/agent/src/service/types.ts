/**
 * Platform-neutral interface for installing the agent as a background
 * service so users don't have to keep `workgraph run` in a terminal.
 *
 * macOS  → LaunchAgent plist under ~/Library/LaunchAgents
 * Linux  → systemd --user unit under ~/.config/systemd/user
 * Win    → not implemented yet (use Task Scheduler manually)
 */

export interface ServiceInstaller {
  /** Filesystem path the service definition is written to. */
  unitPath: string;
  /** Where stdout / stderr land when the service is running. */
  logsPath: string;
  /** Install the service and start it. */
  install(opts: { binaryPath: string; nodePath: string }): Promise<void>;
  /** Stop + unregister the service. */
  uninstall(): Promise<void>;
  /** Is the service registered and running right now? */
  status(): Promise<ServiceStatus>;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  /** Free-form note: "loaded", "stopped", "not installed", "error: ..." */
  note?: string;
}
