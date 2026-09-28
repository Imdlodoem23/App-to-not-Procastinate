import type { Clock } from '../contracts';

/** The real clock. The harness's frozen clock lives in the core (`CoreHarness.advance`). */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
