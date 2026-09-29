import type { GuardianClient } from '@centrate/shared/guardian-api';
import type { CoreHost } from '../../../src/main/contracts';
import type { ManualClock } from '../../../src/main/guardian/clock';

/** Let pending promise chains run (several macrotask turns). */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Advance a manual clock by `ms`, stopping at every due timer and letting the promise
 * chains it starts run before the next one (so async loops re-arm their timers).
 */
export async function run(clock: ManualClock, ms: number): Promise<void> {
  const end = clock.now() + ms;
  for (let guard = 0; guard < 100_000; guard += 1) {
    await settle();
    const next = clock.nextDueAt();
    if (next === null || next > end) break;
    clock.advance(Math.max(0, next - clock.now()));
  }
  clock.advance(Math.max(0, end - clock.now()));
  await settle();
}

export interface CallLog {
  method: keyof GuardianClient;
  args: unknown[];
}

/**
 * Wraps a client: records every call and lets a test replace single methods
 * (`overrides.createBlock = () => never()`).
 */
export function spyClient(
  base: GuardianClient,
  overrides: Partial<Record<keyof GuardianClient, (...args: unknown[]) => Promise<unknown>>> = {},
): { client: GuardianClient; calls: CallLog[]; overrides: typeof overrides } {
  const calls: CallLog[] = [];
  const client = new Proxy({} as GuardianClient, {
    get(_t, prop) {
      const method = prop as keyof GuardianClient;
      return (...args: unknown[]) => {
        calls.push({ method, args });
        const override = overrides[method];
        if (override) return override(...args);
        const fn = base[method] as unknown as (...a: unknown[]) => Promise<unknown>;
        return fn.apply(base, args);
      };
    },
  });
  return { client, calls, overrides };
}

export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export function hostStub(
  initial: { anyVisible?: boolean; mainFocused?: boolean } = {},
): CoreHost & { state: { anyVisible: boolean; mainFocused: boolean }; clipboard: string[]; shown: string[] } {
  const state = { anyVisible: initial.anyVisible ?? true, mainFocused: initial.mainFocused ?? false };
  const clipboard: string[] = [];
  const shown: string[] = [];
  return {
    state,
    clipboard,
    shown,
    visibility: () => ({ ...state }),
    showMain: (reason) => {
      shown.push(reason);
    },
    writeClipboard: (text) => {
      clipboard.push(text);
    },
  };
}

/** Deterministic PRNG (property tests without a dependency). */
export function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}
