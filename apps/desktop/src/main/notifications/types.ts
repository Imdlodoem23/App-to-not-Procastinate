/** What a native notification shows (the Electron adapter and the harness recorder). */
export interface NotificationContent {
  title: string;
  body: string;
  /** Notice kinds grouped into it (`block_finished`, `attempt`, `close_hint`…). */
  kinds: string[];
}

/** Shows native notifications. A new one closes the previous one. */
export interface Notifier {
  show(content: NotificationContent): void;
  /** Close whatever is still on screen (shutdown). */
  closeAll(): void;
}

/** Records instead of showing (harness mode, tests). */
export function createRecordingNotifier(): Notifier & { shown: NotificationContent[] } {
  const shown: NotificationContent[] = [];
  return {
    shown,
    show(content) {
      shown.push(content);
    },
    closeAll() {
      // nothing on screen
    },
  };
}
