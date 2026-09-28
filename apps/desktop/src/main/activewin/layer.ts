/**
 * The active-window layer (PROMPT §5 capa 4): while a block is active, read the foreground
 * window every ~2 s and report a covered service's title as an attempt. Nothing runs without an
 * active block (no timer at all), so a quiet app stays under 1 % CPU. Its status goes to
 * `snapshot.activeWindow` (Ajustes › Sistema shows it):
 *
 * - `off`: no active block (or the guardian is down, so nothing would be enforced);
 * - `ok`: watching;
 * - `needs-permission`: macOS without Screen Recording (re-checked every 30 s);
 * - `unsupported`: Wayland, no display, no xprop, or no FFI (the layer stays off this run);
 * - `error`: the last read failed (retried after 10 s).
 *
 * The host (the core) owns the guardian client; this class gets a `report` function only.
 */
import type { AttemptResponse, GuardianStateResponse } from '@centrate/shared/guardian-api';
import type { BrowserFamily } from '@centrate/shared/domain';
import type { ActiveWindowStatus, PermissionOutcome } from '../../shared/platform';
import type { Platform } from '../../shared/ui-state';
import type { Clock, TimerHandle } from '../contracts';
import {
  ACTIVE_WINDOW_ERROR_BACKOFF_MS,
  ACTIVE_WINDOW_PERMISSION_RECHECK_MS,
  ACTIVE_WINDOW_POLL_MS,
  ReportThrottle,
  browserOfProcess,
  hasActiveBlock,
  isServiceCovered,
  serviceOfWindow,
} from './match';
import type { ForegroundReader } from './reader';
import type { LogFields } from '../logs/logger';

export interface ActiveWindowLayerOptions {
  platform: Platform;
  clock: Clock;
  reader: ForegroundReader;
  /** `POST /v1/attempts` with `layer: "window"` (the host's guardian client). */
  report(serviceId: string, browser: BrowserFamily | null): Promise<AttemptResponse>;
  /** Publishes the status (`Core.patchSnapshot({ activeWindow })`). */
  publish(status: ActiveWindowStatus): void;
  log(event: string, fields: LogFields): void;
}

export class ActiveWindowLayer {
  private state: GuardianStateResponse | null = null;
  private linkOk = false;
  private timer: TimerHandle | null = null;
  private running = false;
  private busy = false;
  private unsupported = false;
  private stopped = false;
  private status: ActiveWindowStatus = { status: 'off', lastMatch: null };
  private readonly throttle = new ReportThrottle();

  constructor(private readonly options: ActiveWindowLayerOptions) {}

  current(): ActiveWindowStatus {
    return {
      ...this.status,
      lastMatch: this.status.lastMatch ? { ...this.status.lastMatch } : null,
    };
  }

  /** Every new guardian state (and link change): start or stop watching. */
  sync(state: GuardianStateResponse | null, linkOk: boolean): void {
    if (this.stopped) return;
    this.state = state;
    this.linkOk = linkOk;
    const watch = linkOk && hasActiveBlock(state) && !this.unsupported;
    if (watch && !this.running) {
      this.running = true;
      this.schedule(0);
    } else if (!watch && this.running) {
      this.halt();
      if (!this.unsupported) this.set({ ...this.status, status: 'off' });
    }
  }

  async requestPermission(): Promise<PermissionOutcome> {
    const outcome = await this.options.reader.requestPermission();
    if (outcome === 'granted' && this.status.status === 'needs-permission') {
      this.set({ ...this.status, status: this.running ? 'ok' : 'off' });
      if (this.running) this.schedule(0);
    }
    return outcome;
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }

  private halt(): void {
    this.running = false;
    this.throttle.reset();
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(next: ActiveWindowStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.options.publish(this.current());
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy || this.stopped) return;
    this.busy = true;
    let next = ACTIVE_WINDOW_POLL_MS;
    try {
      const read = await this.options.reader.read();
      if (!this.running) return;
      switch (read.kind) {
        case 'unsupported':
          this.unsupported = true;
          this.halt();
          this.set({ status: 'unsupported', lastMatch: null });
          return;
        case 'needs-permission':
          this.throttle.reset();
          this.set({ ...this.status, status: 'needs-permission' });
          next = ACTIVE_WINDOW_PERMISSION_RECHECK_MS;
          break;
        case 'error':
          this.throttle.reset();
          this.set({ ...this.status, status: 'error' });
          next = ACTIVE_WINDOW_ERROR_BACKOFF_MS;
          break;
        case 'none':
          this.throttle.shouldReport(null, this.options.clock.now());
          this.set({ ...this.status, status: 'ok' });
          break;
        case 'window': {
          this.set({ ...this.status, status: 'ok' });
          const found = serviceOfWindow(read.window);
          const covered = found !== null && isServiceCovered(this.state, found) ? found : null;
          const now = this.options.clock.now();
          if (covered !== null && this.linkOk && this.throttle.shouldReport(covered, now)) {
            await this.send(covered, browserOfProcess(read.window.process, this.options.platform));
          } else if (covered === null) {
            this.throttle.shouldReport(null, now);
          }
          break;
        }
      }
    } catch (error) {
      this.options.log('activewin_tick_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      next = ACTIVE_WINDOW_ERROR_BACKOFF_MS;
    } finally {
      this.busy = false;
      if (this.running && !this.stopped) this.schedule(next);
    }
  }

  private async send(serviceId: string, browser: BrowserFamily | null): Promise<void> {
    try {
      const r = await this.options.report(serviceId, browser);
      // A merged sighting of the same service keeps the snapshot (no push every 10 s).
      if (r.blocked && (r.counted || this.status.lastMatch?.serviceId !== serviceId)) {
        this.set({ status: 'ok', lastMatch: { serviceId, at: this.options.clock.now() } });
      }
      if (r.counted) this.options.log('activewin_attempt', { counted: true });
    } catch (error) {
      // The guardian may be restarting: the next sighting reports again.
      this.throttle.reset();
      this.options.log('activewin_report_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
