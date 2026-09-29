/**
 * «¡Estaba estudiando!» episodes (owner: DECISION). DESIGN.md §7.10.
 *
 * Entering DUDA, entering «No te veo» and a strike each open an episode. The observations of
 * the last 90 s stay in memory (numbers only, never stored) so the user can vouch for them;
 * the engine selects up to 30 usable frames and LEARNING retrains. Nothing here touches a
 * strike: the guardian never refunds one.
 *
 * Frames with a phone in hand are never offered, with one exception: when the episode's low
 * time was mostly E_phone and that phone stayed at one spot (lying on the desk and misread
 * as «in hand»), its frames are offered with the phone removed, and applying the episode
 * hands the spot to the observer, which then ignores a phone there while it stays put.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import { atSpot, stayedPut, withoutDeskPhone, type DeskPhoneVouch } from '../score/desk-phone';
import type {
  Box,
  FeedbackEpisode,
  FeedbackEpisodeResult,
  FeedbackFrame,
  FrameFeatures,
  MonoMs,
  Observation,
  StudyMode,
} from '../types';
import { FEEDBACK_MAX_ENTRY_MS, FEEDBACK_PHONE_SHARE } from './constants';

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
  /** The desk phone found by the last `episode()` call, or `null`. */
  deskPhone: DeskPhoneVouch | null;
}

/** What applying an episode hands back to the engine. */
export interface UsedEpisode {
  deskPhone: DeskPhoneVouch | null;
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

/**
 * The phone the user would vouch for: E_phone during ≥ 50 % of the episode's low work time,
 * and its detector sightings stayed at one spot. `null` otherwise (a phone in the hand moves).
 */
export function deskPhoneOf(
  span: readonly { at: MonoMs; work: boolean; obs: Observation }[],
  from: MonoMs,
  to: MonoMs,
): DeskPhoneVouch | null {
  let lowMs = 0;
  let phoneMs = 0;
  let prevAt: MonoMs | null = null;
  let width = 0;
  let height = 0;
  const runs = new Set<number>();
  const sightings: Box[] = [];
  for (const e of span) {
    const ms = prevAt === null ? 0 : Math.min(FEEDBACK_MAX_ENTRY_MS, Math.max(0, e.at - prevAt));
    prevAt = e.at;
    if (!e.work) continue;
    if (e.obs.cause !== null) {
      lowMs += ms;
      if (e.obs.evidence.phone) phoneMs += ms;
    }
    const frame = e.obs.frame;
    const objects = frame?.objects;
    if (frame && objects?.fresh && objects.phone && !runs.has(objects.ranAt)) {
      runs.add(objects.ranAt);
      sightings.push(objects.phone.box);
      width = frame.width;
      height = frame.height;
    }
  }
  if (lowMs <= 0 || phoneMs / lowMs < FEEDBACK_PHONE_SHARE) return null;
  const spot = stayedPut(sightings, width, height);
  return spot ? { ...spot, from, to } : null;
}

/** The frame's phone (if any) is the vouched desk phone. */
function phoneAtSpot(frame: FrameFeatures, spot: DeskPhoneVouch): boolean {
  const phone = frame.objects?.phone;
  return !phone || atSpot(phone.box, spot);
}

export class FeedbackBook {
  /** Observations of the last 90 s from `head` on (older ones are compacted away). */
  private ring: RingEntry[] = [];
  private head = 0;
  private latest: Episode | null = null;
  private nextId = 1;
  private appliedCount = 0;

  push(at: MonoMs, work: boolean, obs: Observation): void {
    this.ring.push({ at, work, obs });
    const from = at - STUDY_AI_CONSTANTS.feedbackBufferMs;
    while (this.head < this.ring.length && (this.ring[this.head] as RingEntry).at < from)
      this.head += 1;
    if (this.head >= 256 && this.head * 2 >= this.ring.length) {
      this.ring = this.ring.slice(this.head);
      this.head = 0;
    }
  }

  open(trigger: Episode['trigger'], at: MonoMs): void {
    this.latest = { id: this.nextId, trigger, openedAt: at, used: false, deskPhone: null };
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
    const span = this.ring.slice(this.head).filter((e) => e.at >= from && e.at <= now);
    const desk = deskPhoneOf(span, from, now);
    ep.deskPhone = desk;
    const usable = span.filter(
      (e) =>
        e.work &&
        e.obs.frame !== null &&
        (e.obs.presence === 'visible' || e.obs.presence === 'hidden') &&
        (!e.obs.evidence.phone || (desk !== null && phoneAtSpot(e.obs.frame, desk))),
    );
    if (usable.length === 0) return { ok: false, reason: 'no_usable_frames' };
    const frames = evenlySpaced(usable, c.feedbackMaxFrames).map((e): FeedbackFrame => {
      const frame = e.obs.frame as FrameFeatures;
      return {
        // The vouched desk phone is not part of what the user was doing: LEARNING gets the
        // frame without it (and would reject it as «phone in hand» otherwise).
        frame: desk ? withoutDeskPhone(frame, [desk]) : frame,
        rel: e.obs.rel,
        book: e.obs.evidence.book,
        lookingDown: e.obs.evidence.lookingDown,
      };
    });
    return { ok: true, episodeId: ep.id, trigger: ep.trigger, frames };
  }

  /** Marks the latest episode used; `null` when `id` is not the latest unused one. */
  use(id: number): UsedEpisode | null {
    const ep = this.latest;
    if (!ep || ep.id !== id || ep.used) return null;
    if (this.appliedCount >= STUDY_AI_CONSTANTS.feedbackPerSession) return null;
    ep.used = true;
    this.appliedCount += 1;
    return { deskPhone: ep.deskPhone };
  }
}
