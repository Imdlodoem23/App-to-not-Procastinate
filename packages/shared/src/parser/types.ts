import type { CategoryId } from '../catalog';
import type { IsoWeekday } from '../domain';
import type { LanguageTags } from '../i18n/format';
import type { Locale } from '../i18n/locale';

/**
 * What the phrase asks for: create a block, create a daily limit («YouTube máximo 30
 * minutos al día», card «Límite diario»), propose a Study Mode session, or nothing we can
 * act on (the UI opens the advanced form with whatever was understood).
 */
export type ParseKind = 'block' | 'limit' | 'study' | 'unknown';

/**
 * `daily`: the daily allowance of a limit («30 min al día», value = minutes as a string);
 * `days`: the days a limit applies («entre semana», value = ISO weekdays joined with `,`,
 * e.g. `1,2,3,4,5`).
 */
export type ParseChipKind =
  'service' | 'category' | 'domain' | 'duration' | 'until' | 'task' | 'daily' | 'days';

/** One piece of the phrase that was understood, for the chips under the input field. */
export interface ParseChip {
  kind: ParseChipKind;
  /**
   * Text for the chip in `ParseOptions.locale`: «YouTube», «Redes sociales», «1 h 30 min»,
   * «hasta 20:30» (Spanish, the default); «Social media», «until 8:30 PM» (English).
   */
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
 * - `ambiguous_time`: an hour from 1 to 12 without «de la tarde», «am», «pm», «in the
 *   evening»… was read as its next occurrence («hasta las 8», «until 8» at 16:42 → 20:00);
 *   the UI should show the chosen time.
 * - `limit_out_of_range`: a daily allowance outside `GUARDIAN_LIMITS.limitMinMinutes`…
 *   `limitMaxMinutes` (5 min … 12 h), kept as typed (the UI enforces the range).
 */
export type ParseWarning =
  'over_24h' | 'too_short' | 'past_time' | 'ambiguous_time' | 'limit_out_of_range';

export interface ParseOptions {
  /** Reference time for «hasta las 18:00» and for `endsAt`. */
  now: Date;
  /**
   * Language of the chip labels only (`es` by default). The phrase is read the same way in
   * every locale (Spanish and English, even mixed), and every other field of the result is
   * the same in every locale.
   */
  locale?: Locale;
  /**
   * The user's OS or browser languages (most preferred first), for the region's clock and
   * dates in «until» chips: «until 20:30» for en-GB, «until 8:30 PM» for en-US (the
   * default). See `intlTag`.
   */
  languages?: LanguageTags;
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
  /** Study task typed with the study verb («estudiar mates» → «mates», «study math» → «math»). */
  task?: string;
  /**
   * `limit` only: the daily allowance in minutes («máximo 30 minutos al día» → 30,
   * «1 h al día» → 60). `durationMinutes`/`endsAt` stay unset for a limit.
   */
  dailyMinutes?: number;
  /**
   * `limit` only: ISO weekdays the limit applies, sorted («entre semana» → 1–5, «los fines
   * de semana» → 6, 7); unset when the phrase names no days (the UI defaults to all 7).
   */
  days?: IsoWeekday[];
  /** Sorted by `start`. */
  chips: ParseChip[];
  /** Meaningful fragments that were not understood, for «No he entendido: …». */
  unparsed: string[];
  warnings: ParseWarning[];
  /**
   * True when the phrase can go straight to the confirmation card: a block with at least
   * one target and a duration or end time, a limit with at least one target and
   * `dailyMinutes`, or a study session with a duration, and nothing left unparsed.
   * Nothing is ever invented to make a result complete.
   */
  complete: boolean;
}
