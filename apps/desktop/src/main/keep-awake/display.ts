/**
 * «Mantener también la pantalla encendida» (ARCHITECTURE §5.11): while keep-awake is on with
 * `display` set and the app runs (also in the tray with its window closed), the main process
 * holds Electron's `powerSaveBlocker.start('prevent-display-sleep')`, and releases it as soon
 * as either turns false, its end passes, or the app quits. The guardian keeps the **system**
 * awake on its own; a system service cannot keep the console display on (Windows runs it in
 * session 0), so this part only works while the app runs.
 *
 * No Electron import: the bootstrap passes `powerSaveBlocker` (or, in harness mode, a recording
 * fake), so the rule is unit-tested with a fake clock.
 */
import { keepAwakeDisplayWanted, keepAwakeNextChange } from '../../shared/keep-awake';
import { snapshotNow, type UiSnapshot } from '../../shared/ui-state';
import type { Clock, TimerHandle } from '../contracts';

/** The part of Electron's `powerSaveBlocker` this needs. */
export interface DisplayBlocker {
  /** Starts a `prevent-display-sleep` blocker; returns its id. */
  start(): number;
  stop(id: number): void;
}

export interface DisplayKeeperOptions {
  blocker: DisplayBlocker;
  clock: Clock;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** Longest single wait for the end (timers drift over long sleeps; it simply re-arms). */
const MAX_WAIT_MS = 60 * 60_000;
/** Look again just after the end, so the end has certainly passed. */
const AFTER_END_MS = 50;

export class DisplayKeeper {
  private id: number | null = null;
  private timer: TimerHandle | null = null;
  private last: UiSnapshot | null = null;
  private disposed = false;

  constructor(private readonly options: DisplayKeeperOptions) {}

  /** On every publish: hold or release, and wake up at the end if one is due. */
  sync(snapshot: UiSnapshot): void {
    if (this.disposed) return;
    this.last = snapshot;
    const now = snapshotNow(snapshot, this.options.clock.now());
    this.apply(keepAwakeDisplayWanted(snapshot, now));
    this.schedule(snapshot, now);
  }

  /** The blocker is held now (harness, tests). */
  held(): boolean {
    return this.id !== null;
  }

  /** Quit: release for good. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.apply(false);
  }

  private apply(wanted: boolean): void {
    if (wanted && this.id === null) {
      try {
        this.id = this.options.blocker.start();
        this.options.log?.('display_blocker_started', {});
      } catch (error) {
        this.options.log?.('display_blocker_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    } else if (!wanted && this.id !== null) {
      const id = this.id;
      this.id = null;
      try {
        this.options.blocker.stop(id);
      } catch {
        // already gone
      }
      this.options.log?.('display_blocker_stopped', {});
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(snapshot: UiSnapshot, now: number): void {
    this.clearTimer();
    // The harness's frozen clock only moves with `advance`, which publishes anyway.
    if (snapshot.harness?.frozenNowMs != null) return;
    const end = keepAwakeNextChange(snapshot, now);
    if (end === null) return;
    const delay = Math.min(MAX_WAIT_MS, Math.max(0, end - now) + AFTER_END_MS);
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      if (this.last) this.sync(this.last);
    }, delay);
  }
}
