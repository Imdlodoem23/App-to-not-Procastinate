/**
 * Pure logic of the confirmation card (PROMPT §4, §10 «Confirmación»): what Enter does with
 * a phrase, the card's transitions (mode, reason, consequence step and its 2 s lock), chip
 * corrections, end-time math and the exact request sent to the guardian.
 *
 * The shared draft helpers (`draftFromParse`, `draftToCreateRequest`, `withMode`…) live in
 * `src/shared/ui-state.ts`; this module builds the section's behaviour on top of them.
 * Nothing here invents data: a phrase that is not fully understood goes to Bloqueos with
 * what was understood. Pure: no DOM, Node or Electron imports.
 */
import type { TargetSpec } from '@centrate/shared/domain';
import type { CreateBlockRequest } from '@centrate/shared/guardian-api';
import { GUARDIAN_LIMITS, emptyTargets } from '@centrate/shared/guardian-api';
import { parseIntent, type ParseResult } from '@centrate/shared/parser';
import {
  UI_TIMINGS,
  draftEndsAtMs,
  draftFromParse,
  draftFromTemplate,
  draftMinutes,
  draftNeedsConsequence,
  draftProblem,
  draftSeedFromParse,
  draftToCreateRequest,
  withMode,
  type BlockDraft,
  type BlockTemplate,
  type CardField,
  type CardOrigin,
  type ConfirmCardState,
  type DraftEnd,
  type DraftSeed,
  type IntentId,
  type UiPrefs,
} from '../../../../shared/ui-state';
import type { BlockMode } from '@centrate/shared/domain';
import { durationLabel } from '@centrate/shared/parser';
import { formatClock, intlLocale, targetNames } from '../../../../shared/format';
import { activeLocale, withLocale } from '../../../../shared/i18n/locale';
import { BLOQUEO } from './i18n';
import { untilShort } from './time';

const MIN = 60_000;

/** The parser, with the section's clock. */
export function parsePhrase(text: string, nowMs: number): ParseResult {
  return parseIntent(text, { now: new Date(nowMs) });
}

// ---------------------------------------------------------------------------------------
// Enter in «¿Qué quieres hacer?»
// ---------------------------------------------------------------------------------------

export type FieldEnter =
  /** Empty field: nothing happens. */
  | { kind: 'none' }
  /** Fully understood: the confirmation card opens with this draft. */
  | { kind: 'card'; draft: BlockDraft }
  /** Not (fully) understood: Bloqueos opens with what was understood. */
  | { kind: 'bloqueos'; seed: DraftSeed };

function parseTargets(parse: ParseResult): TargetSpec {
  return {
    ...emptyTargets(),
    serviceIds: [...parse.serviceIds],
    categoryIds: [...parse.categoryIds],
    customDomains: [...parse.domains],
  };
}

function parseEnd(parse: ParseResult): DraftEnd | null {
  const until = parse.chips.some((chip) => chip.kind === 'until');
  if (until && parse.endsAt) return { kind: 'until', endsAt: parse.endsAt };
  if (parse.durationMinutes !== undefined) {
    return { kind: 'duration', minutes: parse.durationMinutes };
  }
  return null;
}

export function targetCount(targets: TargetSpec): number {
  return (
    targets.serviceIds.length +
    targets.categoryIds.length +
    targets.appIds.length +
    targets.customDomains.length +
    targets.customProcesses.length
  );
}

/**
 * «Tu motivo» seeded from a study phrase, in the user's own words: the phrase up to the
 * task («quiero estudiar mates 1 hora» → «Quiero estudiar mates») when nothing else was read
 * before it, else «Estudiar mates». `''` without a task.
 */
export function studyReason(text: string, parse: ParseResult): string {
  const task = parse.chips.find((chip) => chip.kind === 'task');
  if (!task || !parse.task) return '';
  const before = parse.chips.filter((chip) => chip.kind !== 'task' && chip.start < task.end);
  const own = before.length === 0 ? text.slice(0, task.end).trim().replace(/\s+/g, ' ') : '';
  const reason = own !== '' ? own : BLOQUEO.study.reason(parse.task);
  const capital = reason.charAt(0).toLocaleUpperCase(intlLocale()) + reason.slice(1);
  return capital.slice(0, GUARDIAN_LIMITS.reasonMaxLength);
}

/**
 * What Enter does in the field (PROMPT §4 and §10):
 * - a block phrase the parser fully understood → the card, with the default mode and the
 *   last reason;
 * - a study phrase («estudiar mates 1 hora») while Study Mode is not available → a normal
 *   block card of the services it mentions («estudiar mates sin YouTube 1 h»), with the
 *   task as the reason; without services, Bloqueos opens with the duration and the task
 *   noted as the reason (never a block of something the user did not name);
 * - anything else → Bloqueos with what was understood.
 */
export function fieldEnter(text: string, parse: ParseResult, prefs: UiPrefs): FieldEnter {
  if (text.trim() === '') return { kind: 'none' };
  if (parse.kind === 'study') {
    const reason = studyReason(text, parse) || null;
    const targets = parseTargets(parse);
    const end = parseEnd(parse);
    if (targetCount(targets) > 0 && end && parse.unparsed.length === 0) {
      return {
        kind: 'card',
        draft: {
          targets,
          whitelistOnly: false,
          savedTargets: null,
          mode: prefs.defaultMode,
          end,
          reason: reason ?? prefs.lastReason,
        },
      };
    }
    return {
      kind: 'bloqueos',
      seed: {
        phrase: text,
        targets: targetCount(targets) > 0 ? targets : null,
        end,
        mode: null,
        reason,
      },
    };
  }
  const draft = draftFromParse(parse, prefs);
  if (draft) return { kind: 'card', draft };
  return { kind: 'bloqueos', seed: draftSeedFromParse(text, parse) };
}

// ---------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------

export function newCard(
  draft: BlockDraft,
  intentId: IntentId,
  origin: CardOrigin,
  options: { phrase?: string | null; templateId?: string | null } = {},
): ConfirmCardState {
  return {
    intentId,
    origin,
    phrase: options.phrase ?? null,
    templateId: options.templateId ?? null,
    draft,
    step: 'edit',
    consequenceAt: null,
    editing: null,
  };
}

/** Tray «Bloqueo rápido ▸» and the templates row: `null` for an unknown template id. */
export function cardForTemplate(
  templates: readonly BlockTemplate[],
  templateId: string,
  prefs: UiPrefs,
  intentId: IntentId,
  origin: CardOrigin = 'template',
): ConfirmCardState | null {
  const template = templates.find((t) => t.id === templateId);
  if (!template) return null;
  return newCard(draftFromTemplate(template, prefs), intentId, origin, { templateId });
}

/** The templates shown as tiles (the rest live in Bloqueos, behind «Más…»). */
export function visibleTemplates(
  templates: readonly BlockTemplate[],
  max: number = 3,
): BlockTemplate[] {
  return templates.slice(0, max);
}

/** A card whose draft changed goes back to its edit step (the red line no longer applies). */
export function cardWithDraft(card: ConfirmCardState, draft: BlockDraft): ConfirmCardState {
  if (draft === card.draft) return card;
  return { ...card, draft, step: 'edit', consequenceAt: null };
}

export function cardWithMode(card: ConfirmCardState, mode: BlockMode): ConfirmCardState {
  return cardWithDraft(card, withMode(card.draft, mode));
}

/** «Tu motivo» (one line, ≤ 140 UTF-16 units). The consequence step stays as it is. */
export function cardWithReason(card: ConfirmCardState, reason: string): ConfirmCardState {
  const clean = reason.replace(/[\r\n]+/g, ' ').slice(0, GUARDIAN_LIMITS.reasonMaxLength);
  if (clean === card.draft.reason) return card;
  return { ...card, draft: { ...card.draft, reason: clean } };
}

/** When the «Sí, bloquear 6 h» button unlocks (ms), or `null` outside the consequence step. */
export function consequenceUnlockAt(card: ConfirmCardState): number | null {
  if (card.step !== 'consequence' || card.consequenceAt === null) return null;
  return card.consequenceAt + UI_TIMINGS.consequenceLockMs;
}

export function isConsequenceLocked(card: ConfirmCardState, nowMs: number): boolean {
  const unlockAt = consequenceUnlockAt(card);
  return unlockAt !== null && nowMs < unlockAt;
}

export type CardAdvance =
  /** The draft cannot be sent (its problem is on the help line), or the button is locked. */
  | { kind: 'none'; card: ConfirmCardState }
  /** First Enter on > 4 h, Hardcore or Examen: the red line and the 2 s lock. */
  | { kind: 'consequence'; card: ConfirmCardState }
  | { kind: 'submit'; card: ConfirmCardState; request: CreateBlockRequest };

/** Enter (or the confirm button) on the card: edit → (consequence →) submit. */
export function cardAdvance(card: ConfirmCardState, nowMs: number): CardAdvance {
  if (card.editing !== null) return { kind: 'none', card };
  if (draftProblem(card.draft, nowMs) !== null) return { kind: 'none', card };
  if (card.step === 'edit' && draftNeedsConsequence(card.draft, nowMs)) {
    return { kind: 'consequence', card: { ...card, step: 'consequence', consequenceAt: nowMs } };
  }
  if (isConsequenceLocked(card, nowMs)) return { kind: 'none', card };
  return { kind: 'submit', card, request: draftToCreateRequest(card.draft, nowMs) };
}

/** Esc inside the card: close the chip editor, then leave the consequence step, then close. */
export function cardBack(card: ConfirmCardState): ConfirmCardState | null {
  if (card.editing !== null) return { ...card, editing: null };
  if (card.step === 'consequence') return { ...card, step: 'edit', consequenceAt: null };
  return null;
}

/** The draft a create in flight was built from (the card closed or the window reloaded). */
export function draftFromRequest(request: CreateBlockRequest): BlockDraft {
  const end: DraftEnd =
    request.endsAt !== null
      ? { kind: 'until', endsAt: request.endsAt }
      : { kind: 'duration', minutes: request.durationMinutes ?? 0 };
  return {
    targets: {
      serviceIds: [...request.targets.serviceIds],
      categoryIds: [...request.targets.categoryIds],
      appIds: [...request.targets.appIds],
      customDomains: [...request.targets.customDomains],
      customProcesses: [...request.targets.customProcesses],
    },
    whitelistOnly: request.whitelistOnly,
    savedTargets: null,
    mode: request.mode,
    end,
    reason: request.reason,
  };
}

// ---------------------------------------------------------------------------------------
// Duration ⇄ end (always in sync: one `DraftEnd`, two views of it)
// ---------------------------------------------------------------------------------------

/** «1 h» and «hasta 18:00» for the card's chips. */
export function draftEndLabels(
  draft: BlockDraft,
  nowMs: number,
): { duration: string; until: string; minutes: number; endsAtMs: number } {
  const minutes = Math.max(0, draftMinutes(draft, nowMs));
  const endsAtMs = draftEndsAtMs(draft, nowMs);
  return {
    duration: durationLabel(minutes),
    until: untilShort(endsAtMs, nowMs),
    minutes,
    endsAtMs,
  };
}

// ---------------------------------------------------------------------------------------
// Chip corrections («clic en una ficha para corregirla»)
// ---------------------------------------------------------------------------------------

/**
 * Text the inline editor starts with. It is parser input, and the parser reads Spanish only,
 * so it is written in Spanish («Redes sociales», «mañana 08:00») whatever the app language.
 * The one exception: an English end time today is the English clock («6:00 PM»), which the
 * parser reads too, so the editor matches the chip.
 */
export function chipEditText(draft: BlockDraft, field: CardField, nowMs: number): string {
  if (field === 'end' && activeLocale() === 'en') {
    const endsAtMs = draftEndsAtMs(draft, nowMs);
    if (sameLocalDay(endsAtMs, nowMs)) return formatClock(endsAtMs).replace(/\s+/g, ' ');
  }
  return withLocale('es', () => spanishChipEditText(draft, field, nowMs));
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function spanishChipEditText(draft: BlockDraft, field: CardField, nowMs: number): string {
  switch (field) {
    case 'targets':
      return draft.whitelistOnly
        ? ''
        : [
            ...targetNames({ ...emptyTargets(), serviceIds: draft.targets.serviceIds }, false),
            ...targetNames({ ...emptyTargets(), categoryIds: draft.targets.categoryIds }, false),
            ...draft.targets.customDomains,
          ].join(', ');
    case 'duration':
      return durationLabel(Math.max(0, draftMinutes(draft, nowMs)));
    case 'end': {
      const labels = draftEndLabels(draft, nowMs);
      return labels.until.replace(/^hasta /, '');
    }
    case 'mode':
    case 'reason':
      return '';
  }
}

export type ChipEditResult = { ok: true; draft: BlockDraft } | { ok: false; message: string };

function notUnderstood(text: string): ChipEditResult {
  return { ok: false, message: BLOQUEO.field.notUnderstoodAll(text.trim()) };
}

/**
 * Applies what was typed in a chip's inline editor:
 * - `targets`: services, categories and domains read by the parser («yt, redes, marca.com»);
 *   apps and custom processes chosen in Bloqueos are kept. Empty clears them (the card then
 *   asks what to block). Leaving Examen's whitelist: the mode goes back to the default.
 * - `duration`: «45 min», «2h», «1h30», «hora y media», or a bare number of minutes.
 * - `end`: «18:30», «8», «mañana a las 8», «hasta las 20:00».
 * Out-of-range values are kept as typed: the card shows «Entre 5 min y 24 h» instead of
 * silently changing them.
 */
export function applyChipEdit(
  draft: BlockDraft,
  field: CardField,
  text: string,
  nowMs: number,
  prefs: UiPrefs,
): ChipEditResult {
  const clean = text.trim();
  switch (field) {
    case 'targets': {
      const keep = {
        appIds: [...draft.targets.appIds],
        customProcesses: [...draft.targets.customProcesses],
      };
      if (clean === '') {
        return {
          ok: true,
          draft: {
            ...draft,
            targets: { ...emptyTargets(), ...keep },
            whitelistOnly: false,
            savedTargets: null,
            mode: draft.mode === 'exam' ? prefs.defaultMode : draft.mode,
          },
        };
      }
      const parse = parsePhrase(clean, nowMs);
      const found = parseTargets(parse);
      if (targetCount(found) === 0 || parse.unparsed.length > 0) return notUnderstood(clean);
      return {
        ok: true,
        draft: {
          ...draft,
          targets: { ...found, ...keep },
          whitelistOnly: false,
          savedTargets: null,
          mode: draft.mode === 'exam' ? prefs.defaultMode : draft.mode,
        },
      };
    }
    case 'duration': {
      if (/^\d{1,4}$/.test(clean)) {
        return { ok: true, draft: { ...draft, end: { kind: 'duration', minutes: Number(clean) } } };
      }
      const parse = parsePhrase(clean, nowMs);
      const end = parseEnd(parse);
      if (!end || parse.unparsed.length > 0 || targetCount(parseTargets(parse)) > 0) {
        return notUnderstood(clean);
      }
      return { ok: true, draft: { ...draft, end } };
    }
    case 'end': {
      const attempts = /^hasta\b/i.test(clean)
        ? [clean]
        : /^\d/.test(clean)
          ? [`hasta las ${clean}`]
          : [`hasta ${clean}`, `hasta las ${clean}`];
      for (const attempt of attempts) {
        const parse = parsePhrase(attempt, nowMs);
        const until = parse.chips.some((chip) => chip.kind === 'until');
        if (until && parse.endsAt && parse.unparsed.length === 0) {
          return { ok: true, draft: { ...draft, end: { kind: 'until', endsAt: parse.endsAt } } };
        }
      }
      return notUnderstood(clean);
    }
    case 'mode':
    case 'reason':
      return { ok: true, draft };
  }
}

// ---------------------------------------------------------------------------------------
// «Otro…» on the extend row
// ---------------------------------------------------------------------------------------

/**
 * Minutes typed in «Otro…»: a bare number («20»), or a duration the parser reads («1h30»,
 * «hora y media», «2 h»). `null` when it is not a positive duration.
 */
export function parseExtendMinutes(text: string, nowMs: number): number | null {
  const clean = text.trim();
  if (clean === '') return null;
  if (/^\d{1,4}$/.test(clean)) {
    const n = Number(clean);
    return n > 0 ? n : null;
  }
  const parse = parsePhrase(clean, nowMs);
  const isDuration = parse.chips.some((chip) => chip.kind === 'duration');
  if (!isDuration || parse.unparsed.length > 0 || parse.durationMinutes === undefined) return null;
  if (targetCount(parseTargets(parse)) > 0) return null;
  return parse.durationMinutes > 0 ? parse.durationMinutes : null;
}

/** «hasta 18:12» once `addMinutes` more is added to a block ending at `endsAtMs`. */
export function projectedEnd(endsAtMs: number, addMinutes: number): number {
  return endsAtMs + addMinutes * MIN;
}
