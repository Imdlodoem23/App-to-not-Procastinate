/**
 * «¡Estaba estudiando!» episodes (owner: DECISION). DESIGN.md §7.10.
 *
 * Entering DUDA, entering «No te veo» and a strike each open an episode. The observations of
 * the last 90 s stay in memory (numbers only, never stored) so the user can vouch for them;
 * the engine selects up to 30 usable frames and LEARNING retrains. Nothing here touches a
 * strike: the guardian never refunds one.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type {
  FeedbackEpisode,
  FeedbackEpisodeResult,
  FeedbackFrame,
  MonoMs,
  Observation,
  StudyMode,
} from '../types';

interface RingEntry {
  at: MonoMs;
  work: boolean;
  obs: Observation;
}

interface Episode {
  id: number;
  trigger: FeedbackEpisode['trigger'];
  openedAt: MonoMs;
  used: boolean;
}

/** Evenly spaced pick of at most `max` items, first and last included. */
export function evenlySpaced<T>(items: readonly T[], max: number): T[] {
  const n = items.length;
  if (n <= max) return items.slice();
  if (max <= 0) return [];
  if (max === 1) return [items[n - 1] as T];
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.round((i * (n - 1)) / (max - 1))] as T);
  return out;
}

export class FeedbackBook {
  private ring: RingEntry[] = [];
  private latest: Episode | null = null;
  private nextId = 1;
  private appliedCount = 0;

  push(at: MonoMs, work: boolean, obs: Observation): void {
    this.ring.push({ at, work, obs });
    const from = at - STUDY_AI_CONSTANTS.feedbackBufferMs;
    let drop = 0;
    while (drop < this.ring.length && (this.ring[drop] as RingEntry).at < from) drop += 1;
    if (drop > 0) this.ring.splice(0, drop);
  }

  open(trigger: Episode['trigger'], at: MonoMs): void {
    this.latest = { id: this.nextId, trigger, openedAt: at, used: false };
    this.nextId += 1;
  }

  get applied(): number {
    return this.appliedCount;
  }

  episode(now: MonoMs, mode: StudyMode, doubtAfterMs: number): FeedbackEpisodeResult {
    const c = STUDY_AI_CONSTANTS;
    if (mode === 'no-camera') return { ok: false, reason: 'no_camera' };
    if (this.appliedCount >= c.feedbackPerSession) return { ok: false, reason: 'limit_reached' };
    const ep = this.latest;
    if (!ep || now - ep.openedAt > c.feedbackBufferMs || now < ep.openedAt)
      return { ok: false, reason: 'no_episode' };
    if (ep.used) return { ok: false, reason: 'already_used' };
    const from = Math.max(ep.openedAt - doubtAfterMs, now - c.feedbackEpisodeMaxMs);
    const usable = this.ring.filter(
      (e) =>
        e.at >= from &&
        e.at <= now &&
        e.work &&
        e.obs.frame !== null &&
        (e.obs.presence === 'visible' || e.obs.presence === 'hidden') &&
        !e.obs.evidence.phone,
    );
    if (usable.length === 0) return { ok: false, reason: 'no_usable_frames' };
    const frames = evenlySpaced(usable, c.feedbackMaxFrames).map(
      (e): FeedbackFrame => ({
        frame: e.obs.frame as NonNullable<Observation['frame']>,
        rel: e.obs.rel,
        book: e.obs.evidence.book,
        lookingDown: e.obs.evidence.lookingDown,
      }),
    );
    return { ok: true, episodeId: ep.id, trigger: ep.trigger, frames };
  }

  /** Marks the latest episode used; false when `id` is not the latest unused one. */
  use(id: number): boolean {
    const ep = this.latest;
    if (!ep || ep.id !== id || ep.used) return false;
    if (this.appliedCount >= STUDY_AI_CONSTANTS.feedbackPerSession) return false;
    ep.used = true;
    this.appliedCount += 1;
    return true;
  }

  /** Forgets the observations (they belong to the time before a reset). Episodes stay. */
  clearRing(): void {
    this.ring = [];
  }
}
