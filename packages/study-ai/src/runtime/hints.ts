/**
 * The facade's own hints (owner: RUNTIME): `camera_lost`, `over_budget`, `throttled` are
 * debounced like the engine's (on after 5 s active, off after 5 s inactive); `recalibrate`
 * and `vision_failed` are sticky. Pure and DOM-free.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import { HINT_CODES } from '../types';
import type { HintCode, MonoMs } from '../types';

interface Debounced {
  active: boolean;
  /** Since when the raw condition has disagreed with `active`, or `null`. */
  since: MonoMs | null;
}

export interface HintChange {
  code: HintCode;
  active: boolean;
}

export class FacadeHints {
  private readonly debounced = new Map<HintCode, Debounced>();
  private readonly sticky = new Set<HintCode>();

  /** Turns a sticky hint on; returns true when it was not on yet. */
  setSticky(code: HintCode): boolean {
    if (this.sticky.has(code)) return false;
    this.sticky.add(code);
    return true;
  }

  /** Feeds the raw state of a debounced hint; returns the change to announce, if any. */
  update(code: HintCode, raw: boolean, now: MonoMs): HintChange | null {
    const d = this.debounced.get(code) ?? { active: false, since: null };
    this.debounced.set(code, d);
    if (raw === d.active) {
      d.since = null;
      return null;
    }
    if (d.since === null || now < d.since) d.since = now;
    const hold = raw ? STUDY_AI_CONSTANTS.hintOnMs : STUDY_AI_CONSTANTS.hintOffMs;
    if (now - d.since < hold) return null;
    d.active = raw;
    d.since = null;
    return { code, active: raw };
  }

  /** Clears a debounced hint at once (camera switched off on purpose, no-camera mode). */
  clear(code: HintCode): HintChange | null {
    const d = this.debounced.get(code);
    if (!d) return null;
    const was = d.active;
    d.active = false;
    d.since = null;
    return was ? { code, active: false } : null;
  }

  active(): HintCode[] {
    return HINT_CODES.filter((c) => this.sticky.has(c) || this.debounced.get(c)?.active === true);
  }
}

/** Union of hint lists in `HINT_CODES` order. */
export function mergeHints(...lists: readonly (readonly HintCode[])[]): HintCode[] {
  const set = new Set<HintCode>();
  for (const list of lists) for (const code of list) set.add(code);
  return HINT_CODES.filter((c) => set.has(c));
}
