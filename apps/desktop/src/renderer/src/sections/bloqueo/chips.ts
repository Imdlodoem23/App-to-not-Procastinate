/**
 * Chips of section 2 (PROMPT §10): what the parser understood while typing («YouTube · 1 h ·
 * hasta 17:42», a click selects that part of the phrase to correct it) and what the
 * confirmation card blocks (a click edits it in place), and the lists to try when they must
 * fit one line. Also a conservative text-width estimate, so one-line rows pick shorter copy
 * instead of being clipped. Pure module.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import { getApp, getCategory, getService } from '@centrate/shared/catalog';
import { durationLabel, type ParseResult } from '@centrate/shared/parser';
import { SHARED_ES } from '../../../../shared/i18n/es';
import type { BlockDraft, CardField } from '../../../../shared/ui-state';
import { draftEndLabels } from './draft';
import { BLOQUEO_ES } from './i18n/es';
import { untilShort } from './time';

export type ChipKind =
  | 'service'
  | 'category'
  | 'domain'
  | 'app'
  | 'process'
  | 'whitelist'
  | 'duration'
  | 'until'
  | 'task'
  | 'more';

export interface ChipView {
  /** Unique within its row. */
  key: string;
  kind: ChipKind;
  label: string;
  /** Services: the catalog monogram drawn as their icon. */
  monogram: string | null;
  categoryId: CategoryId | null;
  /** Card chips: the field a click corrects. */
  field: CardField | null;
  /** Typing chips: the part of the phrase a click selects. */
  span: { start: number; end: number } | null;
}

function chip(partial: Partial<ChipView> & Pick<ChipView, 'key' | 'kind' | 'label'>): ChipView {
  return { monogram: null, categoryId: null, field: null, span: null, ...partial };
}

/**
 * Chips of what the parser understood, in the card's order: targets, task, duration and end.
 * A duration also shows the end it gives («1 h · hasta 18:00») and an end its duration.
 */
export function typingChips(parse: ParseResult, nowMs: number): ChipView[] {
  const targets: ChipView[] = [];
  const times: ChipView[] = [];
  let task: ChipView | null = null;
  let durationSpan: ChipView['span'] = null;
  let untilSpan: ChipView['span'] = null;
  for (const c of parse.chips) {
    const span = { start: c.start, end: c.end };
    switch (c.kind) {
      case 'service':
        targets.push(
          chip({
            key: `service:${c.value}`,
            kind: 'service',
            label: c.label,
            monogram: getService(c.value)?.monogram ?? null,
            span,
          }),
        );
        break;
      case 'category':
        targets.push(
          chip({
            key: `category:${c.value}`,
            kind: 'category',
            label: c.label,
            categoryId: getCategory(c.value)?.id ?? null,
            span,
          }),
        );
        break;
      case 'domain':
        targets.push(chip({ key: `domain:${c.value}`, kind: 'domain', label: c.label, span }));
        break;
      case 'task':
        task = chip({ key: 'task', kind: 'task', label: c.label, span });
        break;
      case 'duration':
        durationSpan = span;
        break;
      case 'until':
        untilSpan = span;
        break;
    }
  }
  if (parse.durationMinutes !== undefined && (durationSpan || untilSpan)) {
    times.push(
      chip({
        key: 'duration',
        kind: 'duration',
        label: durationLabel(parse.durationMinutes),
        span: durationSpan ?? untilSpan,
      }),
    );
  }
  if (parse.endsAt !== undefined && (durationSpan || untilSpan)) {
    times.push(
      chip({
        key: 'until',
        kind: 'until',
        label: untilShort(Date.parse(parse.endsAt), nowMs),
        span: untilSpan ?? durationSpan,
      }),
    );
  }
  return [...targets, ...(task ? [task] : []), ...times];
}

/** Chips of the card: what is blocked, then duration and end (each editable). */
export function draftChips(draft: BlockDraft, nowMs: number): ChipView[] {
  const out: ChipView[] = [];
  if (draft.whitelistOnly) {
    out.push(
      chip({
        key: 'whitelist',
        kind: 'whitelist',
        label: SHARED_ES.targets.whitelistOnly,
        field: 'targets',
      }),
    );
  } else {
    const t = draft.targets;
    for (const id of t.serviceIds) {
      const service = getService(id);
      out.push(
        chip({
          key: `service:${id}`,
          kind: 'service',
          label: service?.name ?? id,
          monogram: service?.monogram ?? null,
          field: 'targets',
        }),
      );
    }
    for (const id of t.categoryIds) {
      out.push(
        chip({
          key: `category:${id}`,
          kind: 'category',
          label: getCategory(id)?.name ?? id,
          categoryId: id,
          field: 'targets',
        }),
      );
    }
    for (const id of t.appIds) {
      out.push(
        chip({ key: `app:${id}`, kind: 'app', label: getApp(id)?.name ?? id, field: 'targets' }),
      );
    }
    for (const domain of t.customDomains) {
      out.push(chip({ key: `domain:${domain}`, kind: 'domain', label: domain, field: 'targets' }));
    }
    for (const name of t.customProcesses) {
      out.push(chip({ key: `process:${name}`, kind: 'process', label: name, field: 'targets' }));
    }
  }
  const labels = draftEndLabels(draft, nowMs);
  out.push(chip({ key: 'duration', kind: 'duration', label: labels.duration, field: 'duration' }));
  out.push(chip({ key: 'until', kind: 'until', label: labels.until, field: 'end' }));
  return out;
}

// ---------------------------------------------------------------------------------------
// Fitting one line
// ---------------------------------------------------------------------------------------

/** DejaVu Sans measured ~12 % wider than the per-character table below. */
const WIDTH_SCALE = 1.12;
const NARROW = new Set([..." iljíìï|.,:;'!`()[]·"]);
const SEMI = new Set([...'ftrI"-−/']);
const WIDE = new Set([...'mwMWÑ…%@']);

/**
 * Conservative width of `text` in px for the system UI font stack: calibrated on DejaVu Sans,
 * the widest face it can fall back to (Segoe UI and Noto Sans are narrower), so text that
 * «fits» here fits on screen everywhere.
 */
export function estimateTextWidth(text: string, fontPx: number, semibold = false): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.29;
    else if (SEMI.has(ch)) em += 0.4;
    else if (WIDE.has(ch)) em += 0.9;
    else if (/[0-9]/.test(ch)) em += 0.58;
    else if (ch !== ch.toLowerCase()) em += 0.68;
    else em += 0.56;
  }
  return Math.ceil(em * fontPx * WIDTH_SCALE * (semibold ? 1.08 : 1));
}

function isFixed(c: ChipView): boolean {
  return c.kind === 'duration' || c.kind === 'until' || c.kind === 'task';
}

/** «+2» next to targets still shown; «3 webs» when every target hides behind it. */
function moreChip(hidden: readonly ChipView[], shown: number): ChipView {
  const label =
    shown > 0
      ? BLOQUEO_ES.field.moreChips(hidden.length)
      : BLOQUEO_ES.field.hiddenTargets(
          hidden.length,
          hidden.every((c) => c.kind === 'category')
            ? 'category'
            : hidden.some((c) => c.kind === 'category')
              ? 'mixed'
              : 'web',
        );
  return chip({ key: 'more', kind: 'more', label });
}

/**
 * The chip lists to try on one line, widest first: every chip, then fewer targets with a
 * «+N» chip, down to none behind «N webs» (duration, end and task always stay: they are what
 * the user checks). The renderer measures them in the real font and keeps the first that
 * fits (`ChipList`'s `candidates`); the last one is used even if it does not.
 */
export function chipCandidates(chips: readonly ChipView[]): ChipView[][] {
  const fixed = chips.filter(isFixed);
  const flexible = chips.filter((c) => !isFixed(c));
  const out: ChipView[][] = [[...chips]];
  for (let keep = flexible.length - 1; keep >= 0; keep -= 1) {
    out.push([...flexible.slice(0, keep), moreChip(flexible.slice(keep), keep), ...fixed]);
  }
  return out;
}
