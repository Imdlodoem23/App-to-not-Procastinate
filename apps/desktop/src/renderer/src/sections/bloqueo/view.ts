/**
 * `deriveBloqueoView`: section 2 «Bloqueo» as plain data (docs/DESKTOP.md §3.2, §7.6).
 * Components only map this view model to the UI kit; every label, tone, visibility rule and
 * disabled reason is decided here and unit-tested against every harness fixture.
 *
 * Time comes in as `nowMs` (the harness's frozen clock or `Date.now()`); the big countdown
 * itself ticks in its component from `endsAt`. Pure: no DOM, Node or Electron imports.
 */
import type { Block, BlockId, BlockMode, Punishment } from '@centrate/shared/domain';
import { BLOCK_MODES } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { durationLabel } from '@centrate/shared/parser';
import { POINT_RULES } from '@centrate/shared/points';
import { formatPoints, modeLabel, splitCountdown, targetsLabel } from '../../../../shared/format';
import {
  EXTEND_PRESETS,
  activePunishment,
  bloqueoVariant,
  draftEndsAtMs,
  draftMinutes,
  draftProblem,
  finishedNotice,
  isGuardianUnresponsive,
  maxExtendMinutes,
  modeAccent,
  primaryBlock,
  queuedExtendMinutes,
  type BlockTemplate,
  type BloqueoVariant,
  type CardField,
  type DetailRequest,
  type DraftProblem,
  type ExtendEntry,
  type HelpFocus,
  type MainLocalState,
  type UiError,
  type UiPrefs,
  type UiSnapshot,
  type UiState,
} from '../../../../shared/ui-state';
import {
  CHIP_METRICS,
  draftChips,
  estimateTextWidth,
  fitChips,
  typingChips,
  type ChipView,
} from './chips';
import {
  consequenceUnlockAt,
  draftFromRequest,
  fieldEnter,
  isConsequenceLocked,
  parseExtendMinutes,
  parsePhrase,
  projectedEnd,
  visibleTemplates,
  type FieldEnter,
} from './draft';
import { BLOQUEO_ES } from './i18n/es';
import { endsPhrase, untilPhrase, untilShort, whenLabel } from './time';

// ---------------------------------------------------------------------------------------
// Ids shared with the components and RENDERER-CORE
// ---------------------------------------------------------------------------------------

/** `<section id>` of section 2 (focused when a block hides the field). */
export const BLOQUEO_SECTION_ID = 'bloqueo';
/** «¿Qué quieres hacer?»: RENDERER-CORE focuses it on every show (`ui:visibility`). */
export const BLOQUEO_FIELD_ID = 'bloqueo-field';

/**
 * Alt + letter already used by RENDERER-CORE in the same window: section 1 (Reparar «p»,
 * Detalles… «t», Instalar… «i») and the footer (Ajustes… «a», Salir «s», Mini temporizador
 * «z»). Section 2 never takes them, so mnemonics stay unique among visible tiles.
 */
export const RESERVED_MNEMONICS: readonly string[] = ['p', 't', 'i', 'a', 's', 'z'];

/** Help rows of the section (`HelpFocus.row`). */
export const BLOQUEO_ROWS = {
  templates: 'bloqueo-templates',
  modes: 'bloqueo-modes',
  actions: 'bloqueo-actions',
  extend: 'bloqueo-extend',
} as const;

// ---------------------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------------------

export type Accent = 'blue' | 'orange' | 'red' | 'green' | 'neutral';
export type LineTone = 'muted' | 'red' | 'orange' | 'green';

/** Width of the section's content column: 440 − 2 × 12 (DIP). */
export const CONTENT_WIDTH = 416;

export interface HeaderView {
  /** «Bloqueo: YouTube, Instagram · Estricto» (the preferred title). */
  title: string;
  /** `title` and shorter fallbacks, longest first (the section fits them to the real font). */
  titles: string[];
  /** Right-aligned live datum («hasta 17:42», «Próximo horario: 18:00»). */
  datum: string | null;
  datumTone: 'default' | 'green';
  /** The «Nuevo» pill (a block is active and the field is closed). */
  newPill: boolean;
}

export interface TileView {
  id: string;
  label: string;
  help: string;
  disabled: boolean;
  disabledReason: string | null;
  selected: boolean;
  door: boolean;
  accent: Accent | null;
  mnemonic: string | null;
}

export interface LineView {
  tone: LineTone;
  text: string;
}

export interface TemplateTileView extends TileView {
  /** `null` for «Más…». */
  templateId: string | null;
}

export type FieldLine =
  { kind: 'hint'; text: string } | { kind: 'chips'; chips: ChipView[]; note: LineView | null };

export interface ComposerView {
  value: string;
  /** The rotating example («no veo YouTube en una hora»). */
  placeholder: string;
  line: FieldLine;
  /** What Enter would do. */
  enter: FieldEnter['kind'];
  templates: TemplateTileView[];
  templatesHelp: string;
}

export type CardLine =
  | ({ kind: 'text' } & LineView)
  /** A create error: RENDERER-CORE's `errorCopy` words it. */
  | { kind: 'error'; error: UiError };

export type CardActionId = 'edit' | 'confirm' | 'retry' | 'repair';

export interface CardActionView {
  id: CardActionId;
  label: string;
  help: string;
  /** Filled blue (the one confirming control). */
  primary: boolean;
  disabled: boolean;
  /** Pressable but ignored: «Sí, bloquear 6 h» during its 2 s (keeps focus). */
  locked: boolean;
  /** Grid columns out of 4. */
  span: 1 | 2 | 3 | 4;
  mnemonic?: string | null;
}

export interface CardView {
  kind: 'card';
  status: 'edit' | 'consequence' | 'pending' | 'failed';
  /** The card can still be changed (not while sending or after an unanswered create). */
  editable: boolean;
  /** The phrase field stays above the card when the card came from it. */
  composer: { value: string } | null;
  chips: ChipView[];
  editing: CardField | null;
  modes: TileView[];
  modeHelp: string;
  reason: string;
  actions: CardActionView[];
  actionsHelp: CardLine;
  /** `consequenceAt + 2 s` while locked (the component re-renders then). */
  unlockAt: number | null;
  problem: DraftProblem | null;
}

export type UndoView =
  | { kind: 'waiting'; entryId: string; text: string; button: string; buttonLabel: string }
  | { kind: 'sending'; text: string }
  | { kind: 'failed'; entryId: string; text: string; button: string };

export interface ExtendView {
  blockId: BlockId;
  tiles: TileView[];
  help: string;
  undo: UndoView | null;
  other: {
    open: boolean;
    text: string;
    minutes: number | null;
    canApply: boolean;
    line: LineView;
  };
}

export interface RowView {
  id: BlockId;
  label: string;
  endsAt: string;
  accent: Accent;
}

export type EmergencyView =
  | { kind: 'link'; label: string; help: string; request: DetailRequest }
  | { kind: 'text'; label: string };

export interface ActiveView {
  kind: 'active';
  blockId: BlockId;
  /** `null` in boot hold: «Comprobando la hora…» takes the countdown's place. */
  endsAt: string | null;
  bootHold: string | null;
  bar: { accent: Accent; value: number };
  /** «Tu motivo», in italics on the help line under the bar. */
  reason: string | null;
  punishment: { cause: string; points: string } | null;
  extend: ExtendView | null;
  rows: RowView[];
  more: { count: number; label: string; help: string; request: DetailRequest } | null;
  emergency: EmergencyView | null;
  /** «Nuevo» pressed: the field and the templates under the block. */
  composer: ComposerView | null;
}

export interface ComposerBody {
  kind: 'composer';
  composer: ComposerView;
}

export type BloqueoBody = ComposerBody | CardView | ActiveView;

export interface BloqueoView {
  variant: BloqueoVariant;
  header: HeaderView;
  body: BloqueoBody;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function tile(partial: Partial<TileView> & Pick<TileView, 'id' | 'label' | 'help'>): TileView {
  return {
    disabled: false,
    disabledReason: null,
    selected: false,
    door: false,
    accent: null,
    mnemonic: null,
    ...partial,
  };
}

/** Help of a row: the hovered or focused tile's, else `fallback`. */
function rowHelp(
  help: HelpFocus | null,
  row: string,
  tiles: readonly TileView[],
  fallback: string,
): string {
  if (!help || help.row !== row) return fallback;
  const hit = tiles.find((t) => t.id === help.item);
  if (!hit) return fallback;
  return hit.disabled && hit.disabledReason ? hit.disabledReason : hit.help;
}

/**
 * Alt + letter for each tile: the first letter of its label not taken yet (G-Helper style).
 * `taken` holds letters already used by other visible tiles.
 */
export function assignMnemonics(
  labels: readonly string[],
  taken: Iterable<string> = [],
): (string | null)[] {
  const used = new Set([...taken].map((l) => l.toLowerCase()));
  return labels.map((label) => {
    for (const ch of label.normalize('NFD').replace(/[̀-ͯ]/g, '')) {
      const lower = ch.toLowerCase();
      if (/[a-z]/.test(lower) && !used.has(lower)) {
        used.add(lower);
        return lower;
      }
    }
    return null;
  });
}

/**
 * Header titles for a block, longest first. The section shows the longest one that fits next
 * to its datum and pill in the real font (measured at layout time), e.g. «Bloqueo: YouTube,
 * Instagram · Estricto», else «Bloqueo: YouTube +1 · Estricto».
 */
function blockTitles(block: Block, punishment: Punishment | null): string[] {
  if (punishment) {
    const level = BLOQUEO_ES.punishment.level[punishment.level];
    return [
      BLOQUEO_ES.header.punishment(level, punishment.minutes),
      BLOQUEO_ES.header.punishmentShort(level),
      BLOQUEO_ES.header.punishmentShort(`${punishment.minutes} min`),
    ];
  }
  const mode = modeLabel(block.mode);
  const titles = [2, 1].map((names) =>
    BLOQUEO_ES.header.active(targetsLabel(block.targets, block.whitelistOnly, names), mode),
  );
  // Last resort (wide fallback fonts only): the lock icon already says «Bloqueo».
  titles.push(
    BLOQUEO_ES.header.activeShort(targetsLabel(block.targets, block.whitelistOnly, 1), mode),
  );
  return [...new Set(titles)];
}

function blockOfPunishment(
  state: GuardianStateResponse,
  punishment: Punishment | null,
): Block | null {
  if (punishment) {
    const own = state.blocks.find((b) => b.id === punishment.blockId);
    if (own) return own;
  }
  return primaryBlock(state);
}

function punishmentOf(state: GuardianStateResponse, block: Block): Punishment | null {
  return state.punishments.find((p) => p.blockId === block.id) ?? null;
}

// ---------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------

function deriveHeader(
  variant: BloqueoVariant,
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): HeaderView {
  const state = snapshot.state;
  if (state && state.blocks.length > 0) {
    const punishment = variant === 'punishment' ? activePunishment(state) : null;
    const block = blockOfPunishment(state, punishment);
    if (block) {
      // «Nuevo» goes back to the field; a punishment's title needs the whole line.
      const pill =
        (variant === 'active' || variant === 'boot-hold') && !main.composer.openWhileActive;
      const datum = variant === 'boot-hold' ? null : untilShort(Date.parse(block.endsAt), nowMs);
      const titles = blockTitles(block, punishment);
      return {
        title: titles[0] ?? '',
        titles,
        datum,
        datumTone: 'default',
        newPill: pill,
      };
    }
  }
  if (variant === 'finished') {
    const notice = finishedNotice(state, nowMs);
    const points = notice?.pointsDelta ?? 0;
    return {
      title: BLOQUEO_ES.header.finished,
      titles: [BLOQUEO_ES.header.finished],
      datum:
        points !== 0
          ? BLOQUEO_ES.header.finishedPoints(formatPoints(points, { signed: true }))
          : BLOQUEO_ES.header.finishedNoPoints,
      datumTone: points >= 0 ? 'green' : 'default',
      newPill: false,
    };
  }
  const next = state?.nextSchedule ?? null;
  return {
    title: BLOQUEO_ES.header.none,
    titles: [BLOQUEO_ES.header.none],
    datum: next
      ? BLOQUEO_ES.header.nextSchedule(whenLabel(Date.parse(next.startsAt), nowMs))
      : null,
    datumTone: 'default',
    newPill: false,
  };
}

// ---------------------------------------------------------------------------------------
// Composer: field, chips and templates
// ---------------------------------------------------------------------------------------

/** The example phrase shown while the field is empty (`floor(now / 4 s)`: deterministic). */
export function examplePhrase(nowMs: number, rotateMs: number = 4_000): string {
  const list = BLOQUEO_ES.field.examples;
  const index = Math.floor(nowMs / rotateMs) % list.length;
  return list[index] ?? list[0] ?? '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function fieldLine(text: string, nowMs: number, enter: FieldEnter['kind']): FieldLine {
  if (text.trim() === '') return { kind: 'hint', text: BLOQUEO_ES.field.hint };
  const parse = parsePhrase(text, nowMs);
  const chips = typingChips(parse, nowMs);
  let note: LineView | null = null;
  if (parse.unparsed.length > 0) {
    note = {
      tone: 'muted',
      text: BLOQUEO_ES.field.notUnderstood(parse.unparsed.map((f) => truncate(f, 28))),
    };
  } else if (chips.length === 0) {
    note = { tone: 'muted', text: BLOQUEO_ES.field.notUnderstoodAll(truncate(text.trim(), 40)) };
  } else if (enter === 'bloqueos') {
    const hasTargets = chips.some(
      (c) => c.kind !== 'duration' && c.kind !== 'until' && c.kind !== 'task',
    );
    const hasTime = chips.some((c) => c.kind === 'duration' || c.kind === 'until');
    note = !hasTargets
      ? { tone: 'muted', text: BLOQUEO_ES.field.missingTargets }
      : !hasTime
        ? { tone: 'muted', text: BLOQUEO_ES.field.missingDuration }
        : null;
  }
  const noteWidth = note ? estimateTextWidth(note.text, CHIP_METRICS.fontPx) + 8 : 0;
  const budget = CONTENT_WIDTH - noteWidth;
  const fitted = chips.length > 0 && budget >= 96 ? fitChips(chips, budget) : [];
  return { kind: 'chips', chips: fitted, note };
}

function templateHelp(template: BlockTemplate, prefs: UiPrefs): string {
  const mode = template.mode ?? prefs.defaultMode;
  const modeText =
    template.mode === null
      ? BLOQUEO_ES.templates.modeFromSettings(modeLabel(mode))
      : modeLabel(mode);
  for (const names of [2, 1]) {
    const text = BLOQUEO_ES.templates.help(
      targetsLabel(template.targets, template.whitelistOnly || mode === 'exam', names),
      durationLabel(template.durationMinutes),
      modeText,
    );
    if (estimateTextWidth(text, 12) <= CONTENT_WIDTH) return text;
  }
  return durationLabel(template.durationMinutes);
}

function templateTiles(
  snapshot: UiSnapshot,
  help: HelpFocus | null,
  taken: readonly string[],
): {
  tiles: TemplateTileView[];
  help: string;
} {
  const shown = visibleTemplates(snapshot.templates);
  const labels = [...shown.map((t) => t.label), BLOQUEO_ES.templates.more];
  const mnemonics = assignMnemonics(labels, [...RESERVED_MNEMONICS, ...taken]);
  const tiles: TemplateTileView[] = [
    ...shown.map((t, i) => ({
      ...tile({
        id: t.id,
        label: t.label,
        help: templateHelp(t, snapshot.prefs),
        mnemonic: mnemonics[i] ?? null,
      }),
      templateId: t.id,
    })),
    {
      ...tile({
        id: 'more',
        label: BLOQUEO_ES.templates.more,
        help: BLOQUEO_ES.templates.moreHelp,
        door: true,
        mnemonic: mnemonics[shown.length] ?? null,
      }),
      templateId: null,
    },
  ];
  return {
    tiles,
    help: rowHelp(help, BLOQUEO_ROWS.templates, tiles, BLOQUEO_ES.templates.rowHelp),
  };
}

function composerView(
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
  taken: readonly string[] = [],
): ComposerView {
  const text = main.composer.text;
  const enter = fieldEnter(text, parsePhrase(text, nowMs), snapshot.prefs).kind;
  const templates = templateTiles(snapshot, main.help, taken);
  return {
    value: text,
    placeholder: examplePhrase(nowMs),
    line: fieldLine(text, nowMs, enter),
    enter,
    templates: templates.tiles,
    templatesHelp: templates.help,
  };
}

// ---------------------------------------------------------------------------------------
// The confirmation card (confirm, pending, failed)
// ---------------------------------------------------------------------------------------

const MODE_ORDER: readonly BlockMode[] = BLOCK_MODES;

function cardView(
  variant: BloqueoVariant,
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): CardView {
  const create = snapshot.ops.create;
  const card = main.card;
  const ownCreate = create && (!card || card.intentId === create.intentId) ? create : null;
  const draft = card?.draft ?? (ownCreate ? draftFromRequest(ownCreate.request) : null);
  if (!draft) throw new Error('cardView without a card or a create');

  const failedError = variant === 'failed' ? (ownCreate?.error ?? null) : null;
  const unresponsive = failedError !== null && isGuardianUnresponsive(failedError);
  const status: CardView['status'] =
    variant === 'pending'
      ? 'pending'
      : variant === 'failed'
        ? 'failed'
        : card?.step === 'consequence'
          ? 'consequence'
          : 'edit';
  // A card whose create got no answer stays as sent: «Reintentar» resends it with its key.
  const editable =
    status === 'edit' ||
    status === 'consequence' ||
    (status === 'failed' && !unresponsive && card !== null);

  const problem = draftProblem(draft, nowMs);
  const minutes = Math.max(0, draftMinutes(draft, nowMs));
  const endsAtMs = draftEndsAtMs(draft, nowMs);

  const modes = MODE_ORDER.map((mode) =>
    tile({
      id: mode,
      label: modeLabel(mode),
      help: BLOQUEO_ES.card.modeHelp[mode],
      selected: draft.mode === mode,
      accent: modeAccent(mode),
      disabled: !editable,
      disabledReason: !editable ? BLOQUEO_ES.card.pendingHelp : null,
    }),
  );
  const modeHelp = rowHelp(
    main.help,
    BLOQUEO_ROWS.modes,
    modes,
    BLOQUEO_ES.card.modeHelp[draft.mode],
  );

  const edit: CardActionView = {
    id: 'edit',
    label: BLOQUEO_ES.card.edit,
    help: BLOQUEO_ES.card.editHelp2,
    primary: false,
    disabled: !editable,
    locked: false,
    span: 1,
  };
  let actions: CardActionView[];
  if (status === 'pending') {
    actions = [
      edit,
      {
        id: 'confirm',
        label: BLOQUEO_ES.card.pending,
        help: BLOQUEO_ES.card.pendingHelp,
        primary: true,
        disabled: true,
        locked: false,
        span: 3,
      },
    ];
  } else if (status === 'failed' && unresponsive) {
    actions = [
      {
        id: 'repair',
        label: BLOQUEO_ES.card.repair,
        help: BLOQUEO_ES.card.repairHelp,
        primary: false,
        disabled: false,
        locked: false,
        span: 1,
      },
      {
        id: 'retry',
        label: BLOQUEO_ES.card.retry,
        help: BLOQUEO_ES.card.retryHelp,
        primary: true,
        disabled: false,
        locked: false,
        span: 3,
      },
    ];
  } else {
    const consequence = status === 'consequence';
    const locked = card !== null && consequence && isConsequenceLocked(card, nowMs);
    actions = [
      edit,
      {
        id: 'confirm',
        label: consequence
          ? BLOQUEO_ES.card.confirmAgain(durationLabel(minutes))
          : BLOQUEO_ES.card.confirm(untilShort(endsAtMs, nowMs)),
        help: consequence ? BLOQUEO_ES.card.confirmAgainHelp : BLOQUEO_ES.card.confirmHelp,
        primary: true,
        disabled: problem !== null || !editable,
        locked,
        span: 3,
      },
    ];
  }

  // Alt + letter, unique among the card's tiles (modes first, then the actions).
  const letters = assignMnemonics(
    [...modes.map((m) => m.label), ...actions.map((a) => a.label)],
    RESERVED_MNEMONICS,
  );
  modes.forEach((m, i) => {
    m.mnemonic = letters[i] ?? null;
  });
  actions = actions.map((a, i) => ({ ...a, mnemonic: letters[modes.length + i] ?? null }));

  let actionsHelp: CardLine;
  if (failedError) {
    actionsHelp = { kind: 'error', error: failedError };
  } else if (card?.editing) {
    actionsHelp = { kind: 'text', tone: 'muted', text: BLOQUEO_ES.card.editHelp };
  } else if (problem && status !== 'pending') {
    actionsHelp = { kind: 'text', tone: 'orange', text: BLOQUEO_ES.card.problem[problem] };
  } else if (status === 'consequence') {
    const noEmergency = draft.mode === 'hardcore' || draft.mode === 'exam';
    actionsHelp = {
      kind: 'text',
      tone: 'red',
      text: noEmergency
        ? BLOQUEO_ES.card.consequenceNoEmergency(untilPhrase(endsAtMs, nowMs))
        : BLOQUEO_ES.card.consequenceLong(durationLabel(minutes), endsPhrase(endsAtMs, nowMs)),
    };
  } else {
    const hovered =
      main.help?.row === BLOQUEO_ROWS.actions
        ? actions.find((a) => a.id === main.help?.item)
        : undefined;
    actionsHelp = {
      kind: 'text',
      tone: 'muted',
      text: hovered && status !== 'pending' ? hovered.help : BLOQUEO_ES.card.reminder,
    };
  }

  return {
    kind: 'card',
    status,
    editable,
    composer:
      card?.origin === 'phrase' && main.composer.text !== '' ? { value: main.composer.text } : null,
    chips: draftChips(draft, nowMs),
    editing: editable ? (card?.editing ?? null) : null,
    modes,
    modeHelp,
    reason: draft.reason,
    actions,
    actionsHelp,
    unlockAt: card ? consequenceUnlockAt(card) : null,
    problem,
  };
}

// ---------------------------------------------------------------------------------------
// Active, punishment and boot hold
// ---------------------------------------------------------------------------------------

function elapsedFraction(block: Block, nowMs: number): number {
  const start = Date.parse(block.startsAt);
  const end = Date.parse(block.endsAt);
  if (!(end > start)) return 1;
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

function plusLabel(minutes: number): string {
  return BLOQUEO_ES.active.plus(durationLabel(minutes));
}

function undoView(entries: readonly ExtendEntry[], nowMs: number): UndoView | null {
  const pick =
    entries.find((e) => e.status === 'waiting') ??
    entries.find((e) => e.status === 'sending') ??
    entries.find((e) => e.status === 'failed');
  if (!pick) return null;
  const plus = plusLabel(pick.addMinutes);
  switch (pick.status) {
    case 'waiting': {
      const seconds = Math.max(1, Math.ceil((pick.commitAt - nowMs) / 1000));
      return {
        kind: 'waiting',
        entryId: pick.id,
        text: BLOQUEO_ES.active.undoLine(plus, endsPhrase(Date.parse(pick.projectedEndsAt), nowMs)),
        button: BLOQUEO_ES.active.undo(seconds),
        buttonLabel: BLOQUEO_ES.active.undoLabel(plus),
      };
    }
    case 'sending':
      return { kind: 'sending', text: BLOQUEO_ES.active.sending(plus) };
    case 'failed':
      return {
        kind: 'failed',
        entryId: pick.id,
        text: BLOQUEO_ES.active.failed,
        button: BLOQUEO_ES.card.retry,
      };
  }
}

function extendView(
  snapshot: UiSnapshot,
  main: MainLocalState,
  block: Block,
  nowMs: number,
): ExtendView {
  const max = maxExtendMinutes(block, snapshot.ops, nowMs);
  const queued = queuedExtendMinutes(snapshot.ops, block.id);
  const base = Date.parse(block.endsAt) + queued * 60_000;
  const tiles: TileView[] = EXTEND_PRESETS.map((minutes) => {
    const plus = plusLabel(minutes);
    return tile({
      id: `+${minutes}`,
      label: plus,
      help: BLOQUEO_ES.active.extendTileHelp(plus, endsPhrase(projectedEnd(base, minutes), nowMs)),
      disabled: minutes > max,
      disabledReason: minutes > max ? BLOQUEO_ES.active.maxReached : null,
    });
  });
  tiles.push(
    tile({
      id: 'other',
      label: BLOQUEO_ES.active.other,
      help: BLOQUEO_ES.active.otherHelp,
      door: true,
      disabled: max < 1,
      disabledReason: max < 1 ? BLOQUEO_ES.active.maxReached : null,
    }),
  );
  EXTEND_MNEMONICS.forEach((key, i) => {
    const t = tiles[i];
    if (t) t.mnemonic = key;
  });

  const text = main.extendOther.text;
  const minutes = parseExtendMinutes(text, nowMs);
  let line: LineView;
  if (text.trim() === '') line = { tone: 'muted', text: BLOQUEO_ES.active.otherHelpLabel };
  else if (minutes === null) line = { tone: 'orange', text: BLOQUEO_ES.active.otherInvalid };
  else if (minutes > max) {
    line = {
      tone: 'orange',
      text: BLOQUEO_ES.active.otherTooMuch(durationLabel(Math.max(0, max))),
    };
  } else {
    line = {
      tone: 'muted',
      text: BLOQUEO_ES.active.undoLine(
        plusLabel(minutes),
        endsPhrase(projectedEnd(base, minutes), nowMs),
      ),
    };
  }

  return {
    blockId: block.id,
    tiles,
    help: rowHelp(main.help, BLOQUEO_ROWS.extend, tiles, BLOQUEO_ES.active.extendHelp),
    undo: undoView(
      snapshot.ops.extendQueue.filter((e) => e.blockId === block.id),
      nowMs,
    ),
    other: {
      open: main.extendOther.open,
      text,
      minutes,
      canApply: minutes !== null && minutes <= max,
      line,
    },
  };
}

/** Alt + 1, 3, h, o: each an underlined character of «+15 min», «+30 min», «+1 h», «Otro…». */
const EXTEND_MNEMONICS = ['1', '3', 'h', 'o'] as const;

const ROW_COUNTDOWN_WIDTH = 64 + 12; // «2:10:05» at 13 px tabular + gap.

function rowView(state: GuardianStateResponse, block: Block): RowView {
  const punishment = block.kind === 'punishment' ? punishmentOf(state, block) : null;
  const mode = punishment
    ? BLOQUEO_ES.header.punishment(
        BLOQUEO_ES.punishment.level[punishment.level],
        punishment.minutes,
      )
    : null;
  let label = mode ?? '';
  if (!mode) {
    const budget = CONTENT_WIDTH - ROW_COUNTDOWN_WIDTH - 12;
    for (const names of [2, 1]) {
      label = BLOQUEO_ES.active.row(
        targetsLabel(block.targets, block.whitelistOnly, names),
        modeLabel(block.mode),
      );
      if (estimateTextWidth(label, 13) <= budget) break;
    }
  }
  return {
    id: block.id,
    label,
    endsAt: block.endsAt,
    accent: punishment ? 'red' : modeAccent(block.mode),
  };
}

function emergencyView(
  state: GuardianStateResponse,
  block: Block,
  nowMs: number,
): EmergencyView | null {
  const emergency = state.emergency;
  const request: DetailRequest = { name: 'emergencia', blockIds: null };
  if (emergency && (emergency.status === 'counting' || emergency.status === 'ready')) {
    return {
      kind: 'link',
      label:
        emergency.status === 'ready'
          ? BLOQUEO_ES.active.emergencyReady
          : BLOQUEO_ES.active.emergencyCounting(
              splitCountdown(Date.parse(emergency.readyAt) - nowMs).text,
            ),
      help: BLOQUEO_ES.active.emergencyHelp,
      request,
    };
  }
  if (block.emergencyEligible) {
    return {
      kind: 'link',
      label: BLOQUEO_ES.active.emergency,
      help: BLOQUEO_ES.active.emergencyHelp,
      request,
    };
  }
  if (block.mode === 'hardcore' || block.mode === 'exam') {
    return { kind: 'text', label: BLOQUEO_ES.active.noEmergency[block.mode] };
  }
  return null;
}

/**
 * «Tu motivo» on the line under the bar, beside the emergency link: cut with «…» to the room
 * left (a reason is at most 140 characters; the line never wraps or clips).
 */
function fitReason(reason: string, emergency: EmergencyView | null): string | null {
  const clean = reason.trim().replace(/\s+/g, ' ');
  if (clean === '') return null;
  const budget = CONTENT_WIDTH - (emergency ? estimateTextWidth(emergency.label, 12) + 16 : 0);
  if (estimateTextWidth(clean, 12) <= budget) return clean;
  let cut = clean.length;
  while (cut > 1 && estimateTextWidth(`${clean.slice(0, cut).trimEnd()}…`, 12) > budget) cut -= 1;
  return `${clean.slice(0, cut).trimEnd()}…`;
}

function activeView(
  variant: BloqueoVariant,
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): ActiveView {
  const state = snapshot.state;
  if (!state) throw new Error('activeView without a guardian state');
  const punishment = variant === 'punishment' ? activePunishment(state) : null;
  const block = blockOfPunishment(state, punishment);
  if (!block) throw new Error('activeView without a block');
  const others = state.blocks.filter((b) => b.id !== block.id);
  const bootHold = variant === 'boot-hold';
  const emergency = bootHold ? null : emergencyView(state, block, nowMs);
  return {
    kind: 'active',
    blockId: block.id,
    endsAt: bootHold ? null : block.endsAt,
    bootHold: bootHold ? BLOQUEO_ES.active.bootHold : null,
    bar: {
      accent: punishment ? 'red' : modeAccent(block.mode),
      value: bootHold ? 1 : elapsedFraction(block, nowMs),
    },
    reason: !punishment ? fitReason(block.reason, emergency) : null,
    punishment: punishment
      ? {
          cause: BLOQUEO_ES.punishment.cause(punishment.cause, punishment.task),
          points: formatPoints(-POINT_RULES.punishmentPenalty, { signed: true }),
        }
      : null,
    extend:
      variant === 'active' && block.kind !== 'punishment'
        ? extendView(snapshot, main, block, nowMs)
        : null,
    rows: others.slice(0, 2).map((b) => rowView(state, b)),
    more:
      others.length > 2
        ? {
            count: others.length - 2,
            label: BLOQUEO_ES.active.more(others.length - 2),
            help: BLOQUEO_ES.active.moreHelp,
            request: { name: 'bloqueos', seed: null, focus: 'active' },
          }
        : null,
    emergency,
    composer: main.composer.openWhileActive
      ? composerView(snapshot, main, nowMs, EXTEND_MNEMONICS)
      : null,
  };
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export function deriveBloqueoView(
  state: Pick<UiState, 'snapshot' | 'main'>,
  nowMs: number,
): BloqueoView {
  const { snapshot, main } = state;
  const variant = bloqueoVariant(snapshot, main, nowMs);
  const header = deriveHeader(variant, snapshot, main, nowMs);
  let body: BloqueoBody;
  switch (variant) {
    case 'idle':
    case 'finished':
      body = { kind: 'composer', composer: composerView(snapshot, main, nowMs) };
      break;
    case 'confirm':
    case 'pending':
    case 'failed':
      body = cardView(variant, snapshot, main, nowMs);
      break;
    case 'active':
    case 'punishment':
    case 'boot-hold':
      body = activeView(variant, snapshot, main, nowMs);
      break;
  }
  return { variant, header, body };
}
