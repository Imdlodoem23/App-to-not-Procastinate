/**
 * Tray-click logic (docs/DESKTOP.md §8.2 «Toggle»). Pure.
 *
 * On Windows, clicking the tray icon first takes focus away from the window, so the window
 * receives `blur` just before the click arrives. A blur this recent still counts as focused:
 * the click hides instead of re-showing.
 */
import { UI_TIMINGS } from '../../shared/ui-state';

export type ToggleAction =
  /** Hide the main window (and the detail window with it). */
  | 'hide'
  /** Visible but covered: `show()` + `focus()` bring it to the front. */
  | 'raise'
  /** Hidden: run the full show path. */
  | 'show';

export interface ToggleInput {
  visible: boolean;
  /** The main or the detail window has focus. */
  focused: boolean;
  /** Last time either window lost focus (ms, monotonic), `null` if never. */
  lastBlurAt: number | null;
  now: number;
}

export function decideToggle(
  input: ToggleInput,
  graceMs: number = UI_TIMINGS.trayBlurGraceMs,
): ToggleAction {
  if (!input.visible) return 'show';
  if (input.focused) return 'hide';
  if (input.lastBlurAt !== null && input.now - input.lastBlurAt < graceMs) return 'hide';
  return 'raise';
}

/**
 * Waits for the renderer's `window:show-ack` of one `ui:prepare-show` (at most
 * `UI_TIMINGS.showAckTimeoutMs`). A newer request supersedes an older one, which resolves
 * `null` at once. Timer functions are injected so tests run on a fake clock.
 */
export class ShowAckWaiter<T> {
  private pending: { seq: number; resolve: (value: T | null) => void; timer: unknown } | null =
    null;
  private seq = 0;

  constructor(
    private readonly timers: {
      setTimeout(fn: () => void, ms: number): unknown;
      clearTimeout(handle: unknown): void;
    },
  ) {}

  /** Next sequence number to send with `ui:prepare-show`. */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  wait(seq: number, timeoutMs: number): Promise<T | null> {
    this.settle(null);
    return new Promise<T | null>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (this.pending?.seq === seq) {
          this.pending = null;
          resolve(null);
        }
      }, timeoutMs);
      this.pending = { seq, resolve, timer };
    });
  }

  /** `window:show-ack`: resolves the matching wait; stale or unknown sequences are ignored. */
  ack(seq: number, value: T): boolean {
    if (!this.pending || this.pending.seq !== seq) return false;
    this.settle(value);
    return true;
  }

  private settle(value: T | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    pending.resolve(value);
  }
}
