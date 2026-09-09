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

/**
 * A check the user asked for, which therefore owes them an answer — including
 * "you are up to date" and the reason it failed, neither of which the launch
 * check has any reason to report.
 *
 * Resolves on whichever of the updater's outcomes arrives first. The timeout
 * exists because a stalled network produces no event at all, and a button
 * that spins forever is worse than one that admits defeat.
 */
export function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    return Promise.resolve({ kind: 'unsupported', message: 'Development build' });
  }
  return new Promise((resolve) => {
    const finish = (status: UpdateStatus) => {
      clearTimeout(timer);
      autoUpdater.off('update-available', onAvailable);
      autoUpdater.off('update-not-available', onNone);
      autoUpdater.off('error', onError);
      resolve(status);
    };
    const onAvailable = (info: { version: string }) =>
      finish({ kind: 'available', version: info.version });
    const onNone = () => finish({ kind: 'none', version: app.getVersion() });
    const onError = (err: Error) => finish({ kind: 'error', message: err?.message });
    const timer = setTimeout(
      () => finish({ kind: 'error', message: 'Timed out reaching the update server' }),
      30_000
    );
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNone);
    autoUpdater.on('error', onError);
    autoUpdater
      .checkForUpdates()
      .catch((err: unknown) =>
        finish({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      );
  });
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
