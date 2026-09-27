/**
 * Engine of the «¿Qué quieres hacer?» demo (LiveDemo.astro): runs the app's real parser from
 * @centrate/shared and turns its result into what the page shows.
 *
 * Used twice: at build time, to render the prefilled example into the static HTML, and in the
 * browser, loaded with a deferred import() so the parser and the catalog never weigh on the
 * first view. It does not import copy.ts (that would put every string of the site in the
 * bundle): the strings arrive as an argument, which the page passes through a data attribute.
 */
import { getCategory, getService } from '@centrate/shared/catalog';
import { PARSER_ES, parseIntent, untilLabel, type ParseResult } from '@centrate/shared/parser';
import type { Copy } from '../../content/copy';

export interface DemoStrings {
  result: Copy['demo']['result'];
  duration: Copy['ui']['duration'];
}

export type DemoStatus = 'empty' | 'block' | 'study' | 'partial' | 'none';

export interface DemoView {
  status: DemoStatus;
  /** What was understood, in the order it was typed (chips under the field). */
  chips: string[];
  /** «Céntrate bloquearía YouTube durante 1 h, hasta las 17:42.» */
  sentence: string;
  /** Label + value pairs of the result card (empty when nothing can be done). */
  fields: { label: string; value: string }[];
  /** Grey lines under the fields: the mode, the long-block warnings, a hint. */
  notes: string[];
}

/** Longest block the app accepts, and the point from which it asks twice (brief § 4). */
const MAX_MINUTES = 24 * 60;
const DOUBLE_CONFIRM_MINUTES = 4 * 60;

function fillIn(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** «45 min», «1 h», «1 h 30 min», with the copy's no-break spaces. */
export function formatDuration(minutes: number, t: DemoStrings['duration']): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return fillIn(t.minutes, { m: whole });
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? fillIn(t.hours, { h }) : fillIn(t.hoursMinutes, { h, m });
}

const pad = (value: number): string => String(value).padStart(2, '0');
const clock = (date: Date): string => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** «17:42», or «mañana 08:00» when it ends another day (the parser's own wording). */
function endsLabel(endsAt: Date, now: Date): string {
  const label = untilLabel(endsAt, now);
  const prefix = PARSER_ES.until('');
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

function list(items: readonly string[]): string {
  return new Intl.ListFormat('es', { style: 'long', type: 'conjunction' }).format(items);
}

/** Describes a parse result the way the app would act on it. Never invents anything. */
export function describe(
  text: string,
  result: ParseResult,
  now: Date,
  strings: DemoStrings,
): DemoView {
  const t = strings.result;
  const chips = result.chips.map((chip) =>
    chip.kind === 'duration' ? formatDuration(Number(chip.value), strings.duration) : chip.label,
  );
  const trimmed = text.trim();
  if (trimmed === '') {
    return { status: 'empty', chips: [], sentence: t.empty, fields: [], notes: [] };
  }

  const minutes = result.durationMinutes;
  const endsAt = result.endsAt ? new Date(result.endsAt) : undefined;

  if (result.complete && minutes !== undefined && minutes > MAX_MINUTES) {
    // The app would not take it: say the limit instead of describing a block that cannot be.
    return { status: 'partial', chips, sentence: t.over24h, fields: [], notes: [] };
  }

  if (result.complete && minutes !== undefined && endsAt) {
    const duration = formatDuration(minutes, strings.duration);
    const time = clock(endsAt);
    const ends = endsLabel(endsAt, now);
    const notes: string[] = [];
    if (minutes > DOUBLE_CONFIRM_MINUTES) notes.push(t.over4h);

    if (result.kind === 'study') {
      const sentence = result.task
        ? fillIn(t.study, { duration, task: result.task })
        : // No task typed: the same sentence without its task clause.
          fillIn(t.study.replace(/\s[^{}]*«\{task\}»/, ''), { duration });
      return {
        status: 'study',
        chips,
        sentence,
        fields: [
          { label: t.fields.duration, value: duration },
          { label: t.fields.ends, value: ends },
        ],
        notes,
      };
    }

    // Targets in the order they were typed: services and domains by name, categories whole.
    const inSentence: string[] = [];
    const inField: string[] = [];
    for (const chip of result.chips) {
      if (chip.kind === 'service') {
        const name = getService(chip.value)?.name ?? chip.label;
        inSentence.push(name);
        inField.push(name);
      } else if (chip.kind === 'category') {
        const name = getCategory(chip.value)?.name ?? chip.label;
        inSentence.push(fillIn(t.category, { category: name }));
        inField.push(name);
      } else if (chip.kind === 'domain') {
        inSentence.push(chip.value);
        inField.push(chip.value);
      }
    }
    const byTime = result.chips.some((chip) => chip.kind === 'until');
    const sentence = fillIn(byTime ? t.blockUntil : t.block, {
      services: list(inSentence),
      duration,
      time,
    });
    notes.unshift(t.mode);
    return {
      status: 'block',
      chips,
      sentence,
      fields: [
        { label: t.fields.what, value: list(inField) },
        { label: t.fields.duration, value: duration },
        { label: t.fields.ends, value: ends },
        { label: t.fields.mode, value: t.defaultMode },
      ],
      notes,
    };
  }

  if (result.chips.length > 0) {
    // Part of it was understood: say what, and what was not (the app opens the advanced form).
    const sentence =
      result.unparsed.length > 0
        ? fillIn(t.partial, { understood: list(chips), rest: result.unparsed.join('», «') })
        : t.tryHint;
    return { status: 'partial', chips, sentence, fields: [], notes: [] };
  }

  return {
    status: 'none',
    chips: [],
    sentence: fillIn(t.none, { text: trimmed }),
    fields: [],
    notes: [t.tryHint],
  };
}

/** Parses the phrase with the app's parser and describes the result. */
export function describeIntent(text: string, now: Date, strings: DemoStrings): DemoView {
  return describe(text, parseIntent(text, { now }), now, strings);
}
