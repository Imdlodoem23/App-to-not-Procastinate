import { categoryName, findServiceByAlias, type CategoryId } from '../catalog';
import { toLocale } from '../i18n/locale';
import { findExcluded, markQualifiers } from './clauses';
import { matchUntil } from './clock';
import { matchDuration } from './duration';
import { durationLabel, untilLabel } from './format';
import { hasPositiveDesire, hasUnblockIntent } from './intent';
import { scanStudy } from './study';
import {
  aliasEndsAt,
  CHOICE_CONNECTORS,
  followsTrigger,
  isTriggerAt,
  LIST_CONNECTORS,
  NEGATIVE_CONNECTORS,
  scanTargets,
  type TargetHit,
} from './targets';
import { nextNorm, tokenize, type Token } from './text';
import type { ParseChip, ParseKind, ParseOptions, ParseResult, ParseWarning } from './types';
import { FRAGMENT_KEEP_START, isFiller } from './vocabulary';

/** Limits used for warnings. The UI enforces them; the parser keeps the typed value. */
export const PARSER_LIMITS = Object.freeze({
  minMinutes: 5,
  maxMinutes: 24 * 60,
  /** Longer input is cut before parsing (the field holds one phrase). */
  maxInputLength: 500,
});

type TimeMatch =
  | { kind: 'duration'; start: number; end: number; minutes: number }
  | { kind: 'until'; start: number; end: number; endsAt: Date; warnings: readonly ParseWarning[] };

function findTimes(tokens: readonly Token[], now: Date): TimeMatch[] {
  const times: TimeMatch[] = [];
  for (let i = 0; i < tokens.length;) {
    const until = matchUntil(tokens, i, now);
    if (until) {
      times.push({ kind: 'until', ...until });
      i = until.end;
      continue;
    }
    const duration = matchDuration(tokens, i);
    if (duration) {
      times.push({ kind: 'duration', ...duration });
      i = duration.end;
      continue;
    }
    i += 1;
  }
  return times;
}

function spanText(text: string, tokens: readonly Token[], start: number, end: number): string {
  const first = tokens[start];
  const last = tokens[end - 1];
  return first && last ? text.slice(first.start, last.end) : '';
}

function isSilent(token: Token): boolean {
  return token.type === 'plus' || isFiller(token.norm);
}

/**
 * True when a duration that is also a newspaper («20 minutos») sits where a target goes:
 * right after a block word or «de» («nada de 20 minutos»), after «ni», or after a list
 * connector or comma that follows a target. Never right after a target («tiktok 20
 * minutos») nor next to «o» («20 minutos o 30 minutos»).
 */
function isTargetSlot(tokens: readonly Token[], start: number, end: number): boolean {
  if (CHOICE_CONNECTORS.has(nextNorm(tokens, end))) return false;
  let k = start - 1;
  while (k >= 0 && !tokens[k + 1]?.breakBefore && tokens[k]?.norm === 'el') k -= 1;
  if (k < 0) return false;
  if (tokens[k + 1]?.breakBefore) return aliasEndsAt(tokens, k + 1);
  const word = tokens[k]?.norm ?? '';
  if (CHOICE_CONNECTORS.has(word) || aliasEndsAt(tokens, k + 1)) return false;
  if (NEGATIVE_CONNECTORS.has(word) || isTriggerAt(tokens, k)) return true;
  if (LIST_CONNECTORS.has(word)) return !tokens[k]?.breakBefore && aliasEndsAt(tokens, k);
  return followsTrigger(tokens, start);
}

/** Runs of tokens nobody read, trimmed of filler words, as [start, end) text offsets. */
function leftoverSpans(
  tokens: readonly Token[],
  used: readonly boolean[],
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let run: Token[] = [];
  const flush = (): void => {
    let first = 0;
    let last = run.length - 1;
    while (first <= last) {
      const token = run[first];
      if (!token || !isSilent(token) || FRAGMENT_KEEP_START.has(token.norm)) break;
      first += 1;
    }
    while (last >= first) {
      const token = run[last];
      if (!token || !isSilent(token)) break;
      last -= 1;
    }
    const kept = run.slice(first, last + 1);
    const head = kept[0];
    const tail = kept[kept.length - 1];
    if (head && tail && kept.some((token) => !isSilent(token))) spans.push([head.start, tail.end]);
    run = [];
  };
  tokens.forEach((token, k) => {
    if (used[k]) {
      flush();
      return;
    }
    if (run.length > 0 && token.breakBefore) flush();
    run.push(token);
  });
  flush();
  return spans;
}

/**
 * Parses what the user typed in «¿Qué quieres hacer?» (PROMPT.md section 4), locally and
 * without inventing anything: «no veo YouTube en una hora», «nada de TikTok ni Instagram
 * durante 45 minutos», «bloquea las redes sociales hasta las 20:30», «sin juegos hora y
 * media», «no quiero ver Netflix 2h», «estudiar mates 1 hora». English phrases are read the
 * same way, whatever the UI locale: «no YouTube for an hour», «block TikTok and Instagram
 * for 45 minutes», «block social media until 8:30 pm», «no games for an hour and a half»,
 * «I don't want to watch Netflix for 2h», «study math for 1 hour».
 *
 * Accents and case do not matter; services and categories come from the catalog aliases
 * (plus a one-typo fallback for words of 5+ letters). When several durations or end
 * times are typed, the first one wins and the others go to `unparsed`.
 *
 * Never a block: unblock requests («desbloquea YouTube», «no bloquees TikTok», «unblock
 * YouTube», «don't block TikTok»), phrases that want to use something («ver Netflix 2h»,
 * «necesito el WhatsApp», «I want to watch YouTube»), exceptions («todo menos WhatsApp»,
 * «everything except WhatsApp», which stay in `unparsed`) and later plans («y después
 * YouTube», «and then YouTube»).
 */
export function parseIntent(text: string, opts: ParseOptions): ParseResult {
  const now = opts?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('parseIntent: opts.now must be a valid Date');
  }
  const locale = toLocale(opts.locale);
  const input = typeof text === 'string' ? text.slice(0, PARSER_LIMITS.maxInputLength) : '';
  const tokens = tokenize(input);
  const used: boolean[] = tokens.map(() => false);
  const extraSpans: Array<[number, number]> = [];

  // 1. Durations and end times. «20 minutos» is also a newspaper: while there is another
  //    time expression, a duration that is exactly a service alias and sits where a target
  //    goes («nada de 20 minutos ni marca 1h») is that service.
  const times = findTimes(tokens, now);
  const preset: TargetHit[] = [];
  for (let index = 0; index < times.length && times.length > 1;) {
    const time = times[index];
    // «el 20 minutos»: the article was read as a duration prefix.
    let start = time?.start ?? 0;
    while (time && start < time.end - 1 && tokens[start]?.norm === 'el') start += 1;
    const service =
      time?.kind === 'duration' && isTargetSlot(tokens, start, time.end)
        ? findServiceByAlias(spanText(input, tokens, start, time.end))
        : undefined;
    if (time && service) {
      times.splice(index, 1);
      preset.push({ kind: 'service', id: service.id, label: service.name, start, end: time.end });
    } else {
      index += 1;
    }
  }
  for (const time of times) for (let k = time.start; k < time.end; k += 1) used[k] = true;
  for (const hit of preset) for (let k = hit.start; k < hit.end; k += 1) used[k] = true;
  const [time, ...extraTimes] = times;
  for (const extra of extraTimes) {
    const first = tokens[extra.start];
    const last = tokens[extra.end - 1];
    if (first && last) extraSpans.push([first.start, last.end]);
  }

  // 1b. Words that only qualify a time («2h máx», «una hora entera») or stand for «por»
  //     («tiktok x 1 hora»), then clauses that must not be read as targets («menos
  //     WhatsApp», «y después YouTube»).
  markQualifiers(tokens, used, times);
  const excluded = findExcluded(tokens, used);

  // 2. Study intent and its task, before targets («estudiar redes de computadores»).
  const study = scanStudy(tokens, used, excluded);

  // 3. Block words and targets.
  const scan = scanTargets(tokens, used, preset, excluded);
  const { hasTrigger } = scan;
  let hits = scan.hits;
  if (study && !hasTrigger && hits.length > 0) {
    // «estudiar mates y YouTube»: without a block word, a study phrase blocks nothing.
    for (const hit of hits) {
      const first = tokens[hit.start];
      const last = tokens[hit.end - 1];
      if (first && last) extraSpans.push([first.start, last.end]);
    }
    hits = [];
  }

  const chips: ParseChip[] = [];
  const serviceIds: string[] = [];
  const categoryIds: CategoryId[] = [];
  const domains: string[] = [];
  const chipByTarget = new Map<string, { chip: ParseChip; end: number }>();
  for (const hit of hits) {
    const first = tokens[hit.start];
    const last = tokens[hit.end - 1];
    if (!first || !last) continue;
    const key = `${hit.kind}:${hit.id}`;
    const seen = chipByTarget.get(key);
    if (seen) {
      // «redes socales»: the typo fallback read «socales» as the same category.
      if (seen.end === hit.start) {
        seen.chip.end = last.end;
        seen.end = hit.end;
      }
      continue;
    }
    if (hit.kind === 'service') serviceIds.push(hit.id);
    else if (hit.kind === 'category') categoryIds.push(hit.id);
    else domains.push(hit.id);
    const label =
      hit.kind === 'domain'
        ? hit.id
        : hit.kind === 'category'
          ? categoryName(hit.id, locale)
          : hit.label;
    const chip: ParseChip = {
      kind: hit.kind,
      label,
      value: hit.id,
      start: first.start,
      end: last.end,
    };
    chips.push(chip);
    chipByTarget.set(key, { chip, end: hit.end });
  }

  let durationMinutes: number | undefined;
  let endsAt: Date | undefined;
  const warnings = new Set<ParseWarning>();
  if (time) {
    const first = tokens[time.start];
    const last = tokens[time.end - 1];
    if (time.kind === 'duration') {
      durationMinutes = time.minutes;
      endsAt = new Date(now.getTime() + time.minutes * 60_000);
    } else {
      endsAt = time.endsAt;
      durationMinutes = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 60_000));
      for (const warning of time.warnings) warnings.add(warning);
    }
    if (first && last) {
      chips.push(
        time.kind === 'duration'
          ? {
              kind: 'duration',
              label: durationLabel(durationMinutes, locale),
              value: String(durationMinutes),
              start: first.start,
              end: last.end,
            }
          : {
              kind: 'until',
              label: untilLabel(endsAt, now, locale, opts.languages),
              value: endsAt.toISOString(),
              start: first.start,
              end: last.end,
            },
      );
    }
    if (durationMinutes > PARSER_LIMITS.maxMinutes) warnings.add('over_24h');
    if (durationMinutes < PARSER_LIMITS.minMinutes) warnings.add('too_short');
  }

  let task: string | undefined;
  if (study?.task) {
    const first = tokens[study.task.start];
    const last = tokens[study.task.end - 1];
    if (first && last) {
      task = input.slice(first.start, last.end);
      chips.push({ kind: 'task', label: task, value: task, start: first.start, end: last.end });
    }
  }

  const unparsed = [...leftoverSpans(tokens, used), ...extraSpans]
    .sort((a, b) => a[0] - b[0])
    .map(([start, end]) => input.slice(start, end));

  const hasTarget = serviceIds.length + categoryIds.length + domains.length > 0;
  const wantsToUse = !hasTrigger && hasPositiveDesire(tokens, hits);
  let kind: ParseKind = 'unknown';
  if (!hasUnblockIntent(tokens)) {
    if (study) kind = 'study';
    else if (hasTarget && !wantsToUse) kind = 'block';
  }
  const hasTime = durationMinutes !== undefined;
  const complete =
    unparsed.length === 0 && (kind === 'study' ? hasTime : kind === 'block' && hasTime);

  chips.sort((a, b) => a.start - b.start);
  return {
    kind,
    serviceIds,
    categoryIds,
    domains,
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(endsAt ? { endsAt: endsAt.toISOString() } : {}),
    ...(task !== undefined ? { task } : {}),
    chips,
    unparsed,
    warnings: [...warnings],
    complete,
  };
}
