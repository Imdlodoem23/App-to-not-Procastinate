/**
 * When the Nuclear overlay may take over the computer (PROMPT §4 «Nuclear», §10 «Nuclear»).
 * Pure: a function of the snapshot and «now».
 *
 * The overlay is unclosable, so it must only stand on data the app can trust: the guardian
 * says `nuclearActive` **and** the link is `ok` **and** the punishment's end is still ahead.
 * The poller keeps the last state when the guardian stops answering (only `link` changes), so
 * a crashed, stopped or repaired guardian, or an end time that already passed, never leaves the
 * screen locked on stale data. Enforcement while the guardian lives is unchanged: it relaunches
 * the app with `--centrate-nuclear` when the heartbeat stops.
 *
 * The same test gates the quit refusals (tray «Salir», footer, Cmd+Q, update install) and the
 * tray's «Salida de emergencia…».
 */
import { nuclearEndsAt, type UiSnapshot } from '../../shared/ui-state';

/** The overlay is re-checked this long after the punishment's end (clock skew, rounding). */
export const NUCLEAR_END_GRACE_MS = 300;

/** `true` while a Nuclear punishment is certain enough to cover the screens. */
export function nuclearTrusted(
  snapshot: Pick<UiSnapshot, 'state' | 'link'>,
  nowMs: number,
): boolean {
  const state = snapshot.state;
  if (state?.nuclearActive !== true) return false;
  if (snapshot.link.status !== 'ok') return false;
  const endsAt = nuclearEndsAt(state);
  if (endsAt === null) return true;
  const end = Date.parse(endsAt);
  return !Number.isFinite(end) || end > nowMs;
}

/**
 * Milliseconds until the overlay must be looked at again because the punishment ends
 * (`endsAt` + grace); `null` when nothing time-driven is pending.
 */
export function nuclearRecheckDelay(
  snapshot: Pick<UiSnapshot, 'state' | 'link'>,
  nowMs: number,
): number | null {
  if (!nuclearTrusted(snapshot, nowMs)) return null;
  const endsAt = nuclearEndsAt(snapshot.state);
  if (endsAt === null) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - nowMs) + NUCLEAR_END_GRACE_MS;
}

/** Why a quit is let through while Nuclear lasts. */
export type QuitOrigin = 'user' | 'os';

/**
 * Whether a quit request is refused: while Nuclear is trusted, only the OS going away (session
 * end, shutdown) quits; everything the user can repeat («Salir», Cmd+Q, «Reiniciar para
 * actualizar») is refused. A forced kill is the only other way out, which the guardian answers
 * by relaunching the app.
 */
export function quitRefused(locked: boolean, origin: QuitOrigin): boolean {
  return locked && origin === 'user';
}

/**
 * Signals that mean the OS session is going away on Linux and macOS: the session manager or
 * systemd sends SIGTERM (then SIGKILL after its timeout) on logout, a closing terminal sends
 * SIGHUP. Refusing them protects nothing (SIGKILL is as easy and the guardian relaunches the
 * app) and only makes the logout hang. Windows has no such signals (`session-end` instead).
 */
export function quitSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === 'win32' ? [] : ['SIGTERM', 'SIGHUP'];
}

/** The origin of a quit started by `signal`: the OS for SIGTERM / SIGHUP, the user otherwise. */
export function quitOriginOfSignal(signal: NodeJS.Signals): QuitOrigin {
  return signal === 'SIGTERM' || signal === 'SIGHUP' ? 'os' : 'user';
}

/** The guardian relaunches the app with it during a Nuclear punishment (ARCHITECTURE §10.5). */
export const NUCLEAR_ARG = '--centrate-nuclear';

export interface SecondInstanceHandlers {
  /** Ask the guardian now (a fresh, trusted state). */
  refresh(): void;
  /** Make the Nuclear overlay again (`PlatformHost.nuclearRelaunch`). */
  nuclearRelaunch(): void;
  showMain(): void;
}

/**
 * Another launch found this instance running. The guardian's Nuclear relaunch
 * (`--centrate-nuclear`) comes only when heartbeats stopped, so the overlay is not live here:
 * it is never ignored. A fresh state is fetched and the overlay made again; the main window
 * stays as it is. Any other launch shows the main window.
 */
export function onSecondInstance(argv: readonly string[], handlers: SecondInstanceHandlers): void {
  if (argv.includes(NUCLEAR_ARG)) {
    handlers.refresh();
    handlers.nuclearRelaunch();
    return;
  }
  handlers.showMain();
}
