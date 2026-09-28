/**
 * Native notifications through Electron's `Notification` (the only `electron` import of
 * MAIN-GUARDIAN besides `ipc-handlers.ts`). A new notification closes the previous one; a
 * click shows the main window. Windows needs `app.setAppUserModelId(APP_ID)` before
 * `ready` (MAIN-WINDOW does it).
 */
import { Notification } from 'electron';
import type { NotificationContent, Notifier } from './types';

export function createElectronNotifier(options: {
  onClick: () => void;
  /** Absolute path of the app icon (optional; the OS uses the app's own otherwise). */
  icon?: string | null;
}): Notifier {
  let current: Notification | null = null;

  const close = (): void => {
    if (current) {
      try {
        current.close();
      } catch {
        // already gone
      }
      current = null;
    }
  };

  return {
    show(content: NotificationContent): void {
      if (!Notification.isSupported()) return;
      close();
      const n = new Notification({
        title: content.title,
        body: content.body,
        silent: false,
        ...(options.icon ? { icon: options.icon } : {}),
      });
      n.on('click', () => options.onClick());
      n.on('close', () => {
        if (current === n) current = null;
      });
      current = n;
      n.show();
    },
    closeAll: close,
  };
}
