import type { CategoryId } from '../catalog';

/**
 * What the phrase asks for: create a block, propose a Study Mode session, or nothing we
 * can act on (the UI opens the advanced form with whatever was understood).
 */
export type ParseKind = 'block' | 'study' | 'unknown';

export type ParseChipKind = 'service' | 'category' | 'domain' | 'duration' | 'until' | 'task';

/** One piece of the phrase that was understood, for the chips under the input field. */
export interface ParseChip {
  kind: ParseChipKind;
  /** Spanish text for the chip: «YouTube», «Redes sociales», «1 h 30 min», «hasta 20:30». */
  label: string;
  /**
   * Machine value: the service or category id, the domain, the minutes (as a string), the
   * `endsAt` ISO string or the task text.
   */
  value: string;
  /** UTF-16 offsets into the original text: `text.slice(start, end)` is what was read. */
  start: number;
  end: number;
}

/**
 * - `over_24h`: the duration is longer than 24 h (kept as typed; the UI enforces the limit).
 * - `too_short`: the duration is shorter than 5 min (the minimum of the advanced form).
 * - `past_time`: the clock time had already passed today, so it was read as tomorrow.
 * - `ambiguous_time`: an hour from 1 to 12 without «de la tarde», «am»… was read as its
 *   next occurrence («hasta las 8» at 16:42 → 20:00); the UI should show the chosen time.
 */
export type ParseWarning = 'over_24h' | 'too_short' | 'past_time' | 'ambiguous_time';

export interface ParseOptions {
  /** Reference time for «hasta las 18:00» and for `endsAt`. */
  now: Date;
}

export interface ParseResult {
  kind: ParseKind;
  /** Catalog service ids, in the order they were typed. */
  serviceIds: string[];
  categoryIds: CategoryId[];
  /** Domains typed explicitly («marca.com»), normalized with the catalog rules. */
  domains: string[];
  /** Filled together with `endsAt` whenever a duration or an end time was understood. */
  durationMinutes?: number;
  /** ISO 8601 (UTC). For «hasta…» phrases `durationMinutes` is derived from it, rounded up. */
  endsAt?: string;
  /** Study task typed after the study verb («estudiar mates» → «mates»). */
  task?: string;
  /** Sorted by `start`. */
  chips: ParseChip[];
  /** Meaningful fragments that were not understood, for «No he entendido: …». */
  unparsed: string[];
  warnings: ParseWarning[];
  /**
   * True when the phrase can go straight to the confirmation card: a block with at least
   * one target and a duration or end time, or a study session with a duration, and
   * nothing left unparsed. Nothing is ever invented to make a result complete.
   */
  complete: boolean;
}
