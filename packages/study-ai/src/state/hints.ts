/**
 * Debounces observation hints into `hint` events (owner: DECISION). DESIGN.md §7.11: a hint
 * turns on after 5 s active and off after 5 s inactive.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import { HINT_CODES } from '../types';
import type { AttentionEvent, HintCode, MonoMs } from '../types';

interface RawState {
  on: boolean;
  since: MonoMs;
}

export class HintDebouncer {
  private readonly raw = new Map<HintCode, RawState>();
  private readonly active = new Set<HintCode>();

  update(now: MonoMs, codes: readonly HintCode[]): AttentionEvent[] {
    const c = STUDY_AI_CONSTANTS;
    const events: AttentionEvent[] = [];
    for (const code of HINT_CODES) {
      const on = codes.includes(code);
      const prev = this.raw.get(code);
      if (!prev || prev.on !== on) this.raw.set(code, { on, since: now });
      const since = this.raw.get(code)?.since ?? now;
      if (on && !this.active.has(code) && now - since >= c.hintOnMs) {
        this.active.add(code);
        events.push({ type: 'hint', at: now, code, active: true });
      } else if (!on && this.active.has(code) && now - since >= c.hintOffMs) {
        this.active.delete(code);
        events.push({ type: 'hint', at: now, code, active: false });
      }
    }
    return events;
  }

  /** Turns every active hint off at once (breaks, pauses, the end). */
  clear(now: MonoMs): AttentionEvent[] {
    const events: AttentionEvent[] = HINT_CODES.filter((code) => this.active.has(code)).map(
      (code) => ({ type: 'hint', at: now, code, active: false }),
    );
    this.active.clear();
    this.raw.clear();
    return events;
  }

  list(): HintCode[] {
    return HINT_CODES.filter((code) => this.active.has(code));
  }
}
