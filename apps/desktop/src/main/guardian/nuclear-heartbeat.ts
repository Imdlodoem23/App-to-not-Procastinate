/**
 * The Nuclear overlay's liveness (ARCHITECTURE §10.5, `POST /v1/nuclear/heartbeat`): while the
 * guardian says `nuclearActive` and the overlay covers every display (`snapshot.nuclear`, which
 * the overlay windows publish), send `{ overlayShown: true, displays }` every 3 s. Without it
 * for 10 s the guardian relaunches the app with `--centrate-nuclear`. The heartbeat changes no
 * block or punishment; its answer only tells when Nuclear is over (then the state is re-read).
 */
import type {
  NuclearHeartbeatRequest,
  NuclearHeartbeatResponse,
} from '@centrate/shared/guardian-api';
import { UI_TIMINGS, type UiSnapshot } from '../../shared/ui-state';
import type { Clock, TimerHandle } from '../contracts';
import type { LogFields } from '../logs/logger';

export interface NuclearHeartbeatOptions {
  clock: Clock;
  send(body: NuclearHeartbeatRequest): Promise<NuclearHeartbeatResponse>;
  /** An accepted heartbeat (publish `nuclear.lastHeartbeatAt`). */
  onBeat(atMs: number): void;
  /** The guardian says Nuclear is over: refresh the state now. */
  onInactive(): void;
  log(event: string, fields: LogFields): void;
  intervalMs?: number;
}

/** Whether the overlay should be beating for this snapshot. */
export function nuclearBeatDisplays(snapshot: UiSnapshot): number | null {
  if (!snapshot.state?.nuclearActive) return null;
  if (snapshot.link.status !== 'ok') return null;
  if (snapshot.nuclear.overlay !== 'shown') return null;
  return Math.min(16, Math.max(1, snapshot.nuclear.displays));
}

export class NuclearHeartbeat {
  private displays: number | null = null;
  private timer: TimerHandle | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly options: NuclearHeartbeatOptions) {}

  sync(snapshot: UiSnapshot): void {
    if (this.stopped) return;
    const displays = nuclearBeatDisplays(snapshot);
    const was = this.displays;
    this.displays = displays;
    if (displays === null) {
      this.clear();
      return;
    }
    // Starting (or the displays changed): beat now, then every 3 s.
    if (was === null || was !== displays) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clear();
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      void this.beat();
    }, ms);
  }

  private async beat(): Promise<void> {
    const displays = this.displays;
    if (displays === null || this.stopped) return;
    const interval = this.options.intervalMs ?? UI_TIMINGS.nuclearHeartbeatMs;
    if (this.inFlight) {
      this.schedule(interval);
      return;
    }
    this.inFlight = true;
    try {
      const r = await this.options.send({ overlayShown: true, displays });
      if (this.stopped) return;
      this.options.onBeat(this.options.clock.now());
      if (!r.nuclearActive) this.options.onInactive();
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'unknown';
      this.options.log('nuclear_heartbeat_failed', { code });
    } finally {
      this.inFlight = false;
      if (!this.stopped && this.displays !== null && this.timer === null) this.schedule(interval);
    }
  }
}
