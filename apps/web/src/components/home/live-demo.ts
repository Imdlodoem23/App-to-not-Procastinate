/**
 * Engine of the «¿Qué quieres hacer?» demo (LiveDemo.astro): runs the app's real parser from
 * @centrate/shared and turns its result into what the page shows.
 *
 * Used twice: at build time, to render the prefilled example into the static HTML, and in the
 * browser, loaded with a deferred import() so the parser and the catalog never weigh on the
 * first view. It does not import copy.ts (that would put every string of the site in the
 * bundle): the strings arrive as an argument, which the page passes through a data attribute.
 *
 * The parser reads Spanish only. On the English page the phrases stay Spanish, but everything
 * the demo writes (sentence, chips, fields, times, lists) comes from the English copy and the
 * page's locale: nothing here is worded in a fixed language.
 */
import { getCategory, getService } from '@centrate/shared/catalog';
import { daysLabel, parseIntent, type ParseResult } from '@centrate/shared/parser';
import type { Copy } from '../../content/copy';
import { formatDayMonth, formatTime, intlLocale, type Lang } from '../../lib/i18n';

export interface DemoStrings {
  lang: Lang;
  result: Copy['demo']['result'];
  duration: Copy['ui']['duration'];
}

export type DemoStatus = 'empty' | 'block' | 'limit' | 'study' | 'partial' | 'none';

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

function calendarDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

type EndsTemplates = Pick<
  DemoStrings['result'],
  'untilToday' | 'untilTomorrow' | 'untilDate' | 'endsToday' | 'endsTomorrow' | 'endsDate'
>;

/**
 * When a block ends, like the app's parser words it: today («17:42»; the midnight that ends
 * today counts as today), tomorrow («mañana 08:00») or another day («el 30/9 08:00»).
 * `kind` picks the chip form («hasta 17:42») or the field form («17:42»).
 */
function whenLabel(endsAt: Date, now: Date, strings: DemoStrings, kind: 'until' | 'ends'): string {
  const t: EndsTemplates = strings.result;
  const time = formatTime(endsAt, strings.lang);
  const days = calendarDays(now, endsAt);
  const midnight = endsAt.getHours() === 0 && endsAt.getMinutes() === 0;
  if (days <= 0 || (days === 1 && midnight)) {
    return fillIn(kind === 'until' ? t.untilToday : t.endsToday, { time });
  }
  if (days === 1) return fillIn(kind === 'until' ? t.untilTomorrow : t.endsTomorrow, { time });
  const date = formatDayMonth(endsAt, strings.lang);
  return fillIn(kind === 'until' ? t.untilDate : t.endsDate, { date, time });
}

function list(items: readonly string[], lang: Lang): string {
  return new Intl.ListFormat(intlLocale[lang], { style: 'long', type: 'conjunction' }).format(
    items,
  );
}

/** A category's name in the page's language (the catalog's own name as a fallback). */
function categoryName(id: string, strings: DemoStrings): string {
  const names: Readonly<Record<string, string>> = strings.result.categoryNames;
  return names[id] ?? getCategory(id)?.name ?? id;
}

/** The chip under the field for one understood piece of the phrase. */
function chipLabel(chip: ParseResult['chips'][number], now: Date, strings: DemoStrings): string {
  switch (chip.kind) {
    case 'duration':
      return formatDuration(Number(chip.value), strings.duration);
    case 'daily':
      return fillIn(strings.result.perDay, {
        duration: formatDuration(Number(chip.value), strings.duration),
      });
    case 'days':
      return daysLabel(weekdays(chip.value), strings.lang);
    case 'category':
      return categoryName(chip.value, strings);
    case 'service':
      return getService(chip.value)?.name ?? chip.label;
    case 'until': {
      const endsAt = new Date(chip.value);
      return Number.isNaN(endsAt.getTime()) ? chip.label : whenLabel(endsAt, now, strings, 'until');
    }
    default:
      return chip.label;
  }
}

/** «entre semana» → «Entre semana», for a field value. */
function capitalize(text: string, lang: Lang): string {
  return text.charAt(0).toLocaleUpperCase(intlLocale[lang]) + text.slice(1);
}

/** «1,2,3,4,5» (a `days` chip's value) as ISO weekdays; anything else is dropped. */
function weekdays(value: string): number[] {
  return value
    .split(',')
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
}

/** Services, categories and domains in the order they were typed, for the sentence and the card. */
function targetNames(
  result: ParseResult,
  strings: DemoStrings,
): { inSentence: string[]; inField: string[] } {
  const t = strings.result;
  const inSentence: string[] = [];
  const inField: string[] = [];
  for (const chip of result.chips) {
    if (chip.kind === 'service') {
      const name = getService(chip.value)?.name ?? chip.label;
      inSentence.push(name);
      inField.push(name);
    } else if (chip.kind === 'category') {
      const name = categoryName(chip.value, strings);
      inSentence.push(fillIn(t.category, { category: name }));
      inField.push(name);
    } else if (chip.kind === 'domain') {
      inSentence.push(chip.value);
      inField.push(chip.value);
    }
  }
  return { inSentence, inField };
}

/**
 * A daily limit («YouTube máximo 30 minutos al día»): what the app's «Límite diario» card
 * would create. Outside 5 min…12 h the app would not take it, so the demo says the range.
 */
function describeLimit(
  result: ParseResult,
  minutes: number,
  chips: string[],
  strings: DemoStrings,
): DemoView {
  const t = strings.result;
  if (result.warnings.includes('limit_out_of_range')) {
    return { status: 'partial', chips, sentence: t.limitRange, fields: [], notes: [] };
  }
  const { inSentence, inField } = targetNames(result, strings);
  const duration = formatDuration(minutes, strings.duration);
  const perDay = fillIn(t.perDay, { duration });
  const days = daysLabel(result.days ?? [], strings.lang);
  const everyDay =
    result.days === undefined || result.days.length === 0 || result.days.length === 7;
  const sentence = fillIn(t.limit, {
    services: list(inSentence, strings.lang),
    daily: everyDay ? perDay : fillIn(t.limitDays, { daily: perDay, days }),
  });
  return {
    status: 'limit',
    chips,
    sentence,
    fields: [
      { label: t.fields.limited, value: list(inField, strings.lang) },
      { label: t.fields.daily, value: duration },
      { label: t.fields.days, value: capitalize(days, strings.lang) },
      { label: t.fields.mode, value: t.limitMode },
    ],
    notes: [t.limitNote],
  };
}

/** Describes a parse result the way the app would act on it. Never invents anything. */
export function describe(
  text: string,
  result: ParseResult,
  now: Date,
  strings: DemoStrings,
): DemoView {
  const t = strings.result;
  const lang = strings.lang;
  const chips = result.chips.map((chip) => chipLabel(chip, now, strings));
  const trimmed = text.trim();
  if (trimmed === '') {
    return { status: 'empty', chips: [], sentence: t.empty, fields: [], notes: [] };
  }

  if (result.kind === 'limit' && result.complete && result.dailyMinutes !== undefined) {
    return describeLimit(result, result.dailyMinutes, chips, strings);
  }

  const minutes = result.durationMinutes;
  const endsAt = result.endsAt ? new Date(result.endsAt) : undefined;

  if (result.complete && minutes !== undefined && minutes > MAX_MINUTES) {
    // The app would not take it: say the limit instead of describing a block that cannot be.
    return { status: 'partial', chips, sentence: t.over24h, fields: [], notes: [] };
  }

  if (result.complete && minutes !== undefined && endsAt) {
    const duration = formatDuration(minutes, strings.duration);
    const time = formatTime(endsAt, lang);
    const ends = whenLabel(endsAt, now, strings, 'ends');
    const notes: string[] = [];
    if (minutes > DOUBLE_CONFIRM_MINUTES) notes.push(t.over4h);

    if (result.kind === 'study') {
      const sentence = result.task
        ? fillIn(t.study, { duration, task: result.task })
        : fillIn(t.studyNoTask, { duration });
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
    const { inSentence, inField } = targetNames(result, strings);
    const byTime = result.chips.some((chip) => chip.kind === 'until');
    const sentence = fillIn(byTime ? t.blockUntil : t.block, {
      services: list(inSentence, lang),
      duration,
      time,
    });
    notes.unshift(t.mode);
    return {
      status: 'block',
      chips,
      sentence,
      fields: [
        { label: t.fields.what, value: list(inField, lang) },
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
        ? fillIn(t.partial, {
            understood: list(chips, lang),
            rest: result.unparsed.join(t.restSeparator),
          })
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
