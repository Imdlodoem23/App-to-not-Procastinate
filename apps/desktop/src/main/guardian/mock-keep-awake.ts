/**
 * «Mantener despierto» in the `MockGuardian` (ARCHITECTURE §5.11, §8.8 «Keep awake»): the
 * configuration, its transitions and expiry, with the events the real guardian writes. The
 * mock never touches the OS: `active` is simply `on` unless a fixture seeded an error.
 */
import type { EventDataMap, KeepAwakeConfig, KeepAwakeError } from '@centrate/shared/domain';
import {
  DEFAULT_KEEP_AWAKE,
  keepAwakeRequestIsNoop,
  type KeepAwakeRequest,
  type KeepAwakeState,
} from '@centrate/shared/guardian-api';

const MIN = 60_000;

type KeepAwakeEvent = 'keep_awake_on' | 'keep_awake_updated' | 'keep_awake_off';

export interface MockKeepAwakeHost {
  now: () => number;
  emit: <K extends KeepAwakeEvent>(type: K, data: EventDataMap[K]) => void;
  changed: () => void;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class MockKeepAwake {
  private config: KeepAwakeConfig;
  /** A seeded `error` (fixtures for «No se ha podido mantener despierto este equipo»). */
  private readonly error: KeepAwakeError | null;

  constructor(
    private readonly host: MockKeepAwakeHost,
    seed: KeepAwakeState | null,
  ) {
    const c = seed ?? DEFAULT_KEEP_AWAKE;
    this.config = {
      on: c.on,
      durationMinutes: c.durationMinutes,
      display: c.display,
      since: c.since,
      until: c.until,
    };
    this.error = seed?.error ?? null;
  }

  /** Turns it off when `until` passed (`keep_awake_off{expired}`). */
  step(): void {
    const until = this.config.until;
    if (!this.config.on || until === null || Date.parse(until) > this.host.now()) return;
    this.config = { ...this.config, on: false, since: null, until: null };
    this.host.emit('keep_awake_off', { keepAwake: { ...this.config }, reason: 'expired' });
    this.host.changed();
  }

  state(): KeepAwakeState {
    const c = this.config;
    const error = c.on ? this.error : this.error === 'unsupported' ? 'unsupported' : null;
    return { ...c, active: c.on && error === null, error };
  }

  /** `PUT /v1/keep-awake` after validation: full replace, a no-op when nothing changes. */
  set(body: KeepAwakeRequest): KeepAwakeState {
    this.step();
    const before = this.config;
    if (keepAwakeRequestIsNoop(before, body)) return this.state();
    const now = this.host.now();
    const durationChanged = before.durationMinutes !== body.durationMinutes;
    const until = (from: number): string | null =>
      body.durationMinutes === null ? null : iso(from + body.durationMinutes * MIN);
    if (!body.on) {
      this.config = { ...body, since: null, until: null };
    } else if (!before.on) {
      this.config = { ...body, since: iso(now), until: until(now) };
    } else {
      this.config = {
        ...body,
        since: before.since,
        until: durationChanged ? until(now) : before.until,
      };
    }
    const keepAwake = { ...this.config };
    if (before.on && !body.on) this.host.emit('keep_awake_off', { keepAwake, reason: 'user' });
    else if (!before.on && body.on) this.host.emit('keep_awake_on', { keepAwake });
    else this.host.emit('keep_awake_updated', { keepAwake });
    this.host.changed();
    return this.state();
  }
}
