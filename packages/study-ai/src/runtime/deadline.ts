/**
 * Time limits for the steps of a start that may never settle (owner: RUNTIME). Pure and
 * DOM-free: timers are injected.
 *
 * `getUserMedia` can hang on a wedged camera driver (macOS VDCAssistant, a stuck Windows frame
 * server) and the MediaPipe WASM/model load can hang too. Without a limit the analysis window
 * would stay «starting» for good: no report, so main sends no heartbeat and the guardian ends
 * the session as abandoned.
 */
import type { TimerApi } from '../types';

/** `getUserMedia` normally answers within 1–3 s (a cold USB camera included). */
export const CAMERA_OPEN_TIMEOUT_MS = 15_000;
/** Compiling the WASM and loading both models takes 1–5 s even on a slow laptop. */
export const VISION_LOAD_TIMEOUT_MS = 30_000;

/**
 * Settles like `promise`, or rejects with `timeoutError()` after `ms`. A value that arrives
 * after the deadline is handed to `release` (stop the track, close the pipeline) and never
 * used; a late rejection is ignored.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  timers: TimerApi,
  timeoutError: () => Error,
  release: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = timers.set(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError());
    }, ms);
    promise.then(
      (value) => {
        if (settled) {
          try {
            release(value);
          } catch {
            // Releasing a late resource is best effort; nothing else holds it.
          }
          return;
        }
        settled = true;
        timers.clear(handle);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        timers.clear(handle);
        reject(error);
      },
    );
  });
}
