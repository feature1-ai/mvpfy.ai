import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UpdateStatus } from '../../shared/types';

/** Long enough not to be chatty, often enough that a machine left open finds
 *  a release the same day it goes out. */
const RECHECK_MS = 3 * 60 * 60_000;

/**
 * Auto-updates from GitHub Releases.
 *
 * Windows (NSIS) and Linux (AppImage) need nothing from the user: the update
 * downloads in the background and installs the next time the app is quit. The
 * banner offering a restart is a way to have it sooner, not a step.
 *
 * macOS only notifies, because Squirrel refuses to apply an update it cannot
 * verify and these builds are unsigned — turning autoDownload on there would
 * download something that then fails to install. Signing the app makes macOS
 * behave like the others through this same code, changing one line.
 */
export function initAutoUpdates(send: (status: UpdateStatus) => void): void {
  if (!app.isPackaged) return;
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = process.platform !== 'darwin';
  // Explicit rather than relying on the default: this is the line that makes
  // updating hands-off, so it should be visible.
  autoUpdater.autoInstallOnAppQuit = true;
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
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  // Checking only at launch meant a machine left running for a week never
  // noticed a release. The download that follows needs nothing from anyone.
  const timer = setInterval(check, RECHECK_MS);
  app.once('before-quit', () => clearInterval(timer));
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
