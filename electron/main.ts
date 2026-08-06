import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';
import { registerIpc } from './ipc';
import { ensureDirs } from './paths';
import { setRunEventSink, stopAllRuns } from './services/runs';
import { resolveUserPath } from './services/shell';
import { initAutoUpdates } from './services/updates';

/** App bootstrap: window lifecycle plus wiring of services to the renderer. */

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    title: 'mvpfy by feature1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed for the embedded Preview/IDE panes (<webview> tags).
      webviewTag: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  resolveUserPath();
  ensureDirs();
  setRunEventSink({
    output: (ev) => sendToRenderer('run-output', ev),
    exit: (ev) => sendToRenderer('run-exit', ev),
  });
  registerIpc();
  initAutoUpdates((status) => sendToRenderer('update-status', status));
  // Brand the dock in dev; packaged builds use build/icon.icns.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
    } catch {
      // Non-fatal: fall back to the default Electron icon.
    }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAllRuns();
  if (process.platform !== 'darwin') app.quit();
});
