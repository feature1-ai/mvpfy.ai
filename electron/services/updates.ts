import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UpdateStatus } from '../../shared/types';

/**
 * Auto-updates from GitHub Releases. Windows (NSIS) and Linux (AppImage)
 * download and install silently; macOS cannot install unsigned updates, so
 * there we only notify and link to the release. Once builds are signed and
 * notarized, macOS auto-installs through this same code path.
 */
export function initAutoUpdates(send: (status: UpdateStatus) => void): void {
  if (!app.isPackaged) return;
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = process.platform !== 'darwin';
  autoUpdater.on('update-available', (info) => {
    send({ kind: 'available', version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send({ kind: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', () => {
    // Non-fatal: the app keeps working on the current version.
    send({ kind: 'error' });
  });
  autoUpdater.checkForUpdates().catch(() => undefined);
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
