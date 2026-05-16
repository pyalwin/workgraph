/**
 * Platform dispatch for the background-service installer.
 *
 * Returns null on Windows (or any unsupported platform) so callers can
 * print a manual-setup hint instead of throwing.
 */
import type { ServiceInstaller } from './types.js';
import { macosInstaller } from './macos.js';
import { linuxInstaller } from './linux.js';

export function getInstaller(): ServiceInstaller | null {
  if (process.platform === 'darwin') return macosInstaller;
  if (process.platform === 'linux') return linuxInstaller;
  return null;
}

export type { ServiceInstaller, ServiceStatus } from './types.js';
