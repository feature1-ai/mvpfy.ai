import { BrowserWindow, Notification } from 'electron';

/**
 * A desktop notification, for the moments that end a wait.
 *
 * Quiet when the builder is already looking: the screen in front of them says
 * all of this better than a toast does, and a notification for something they
 * just watched happen is the kind of noise that gets notifications turned off
 * — after which the one that matters never arrives either.
 *
 * Clicking it brings mvpfy back, because every one of these is about something
 * that needs them in the app.
 */
export function notify(
  win: BrowserWindow | null,
  notice: { title: string; body: string }
): boolean {
  if (!Notification.isSupported()) return false;
  const live = win && !win.isDestroyed() ? win : null;
  if (live?.isFocused()) return false;
  const shown = new Notification({ title: notice.title, body: notice.body });
  shown.on('click', () => {
    if (!live || live.isDestroyed()) return;
    if (live.isMinimized()) live.restore();
    live.show();
    live.focus();
  });
  shown.show();
  return true;
}
