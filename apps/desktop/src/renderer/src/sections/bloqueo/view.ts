/**
 * `deriveBloqueoView`: section 2 «Bloqueo» as plain data (docs/DESKTOP.md §3.2, §7.6).
 * Components only map this view model to the UI kit; every label, tone, visibility rule and
 * disabled reason is decided here and unit-tested against every harness fixture.
 *
 * Time comes in as `nowMs` (the harness's frozen clock or `Date.now()`); the big countdown
 * itself ticks in its component from `endsAt`. Pure: no DOM, Node or Electron imports.
 */
import type { Block, BlockId, BlockMode, LimitMode, Punishment } from '@centrate/shared/domain';
import { BLOCK_MODES, LIMIT_MODES } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { durationLabel } from '@centrate/shared/parser';
import { POINT_RULES } from '@centrate/shared/points';
import {
  formatClock,
  formatList,
  formatPoints,
  modeLabel,
  splitCountdown,
  targetNames,
  targetsLabel,
} from '../../../../shared/format';
import { SHARED } from '../../../../shared/i18n';
import {
  LIMIT_TEXT,
  isLimitBlock,
  limitBlockName,
  limitProblem,
  type LimitProblem,
} from '../../../../shared/limits';
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
  UI_TIMINGS,
  type BlockDraft,
  type BlockTemplate,
  type BloqueoVariant,
  type CardField,
  type DetailRequest,
  type DraftProblem,
  type ExtendEntry,
  type HelpFocus,
  type MainLocalState,
  type UiError,
  templateLabel,
  type UiPrefs,
  type UiSnapshot,
  type UiState,
} from '../../../../shared/ui-state';
import { RENDERER } from '../../i18n/messages';
import { progresoMnemonics } from '../progreso/view';
import {
  chipCandidates,
  draftChips,
  estimateTextWidth,
  limitChips,
  typingChips,
  type ChipView,
} from './chips';
import {
  consequenceUnlockAt,
  draftFromRequest,
  fieldEnter,
  isConsequenceLocked,
  limitUnlockAt,
  parseExtendMinutes,
  parsePhrase,
  projectedEnd,
  visibleTemplates,
  type FieldEnter,
} from './draft';
import { BLOQUEO } from './i18n';
import { endsPhrase, untilPhrase, untilShort, whenLabel } from './time';

// ---------------------------------------------------------------------------------------
// Ids shared with the components and RENDERER-CORE
// ---------------------------------------------------------------------------------------

/** `<section id>` of section 2 (focused when a block hides the field). */
export const BLOQUEO_SECTION_ID = 'bloqueo';
/** «¿Qué quieres hacer?»: RENDERER-CORE focuses it on every show (`ui:visibility`). */
export const BLOQUEO_FIELD_ID = 'bloqueo-field';

/**
 * Alt + letter already used by RENDERER-CORE in the same window, in the active language:
 * section 1 (Reparar «p», Detalles… «t», Instalar… «i») and the footer (Ajustes… «a», Salir
 * «s», Mini temporizador «z»). Section 2 never takes them, so mnemonics stay unique among
 * visible tiles.
 */
export function reservedMnemonics(): string[] {
  return [
    ...Object.values(RENDERER.protection.mnemonics),
    ...Object.values(RENDERER.footer.mnemonics),
  ];
}

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
  | { kind: 'hint'; text: string }
  | {
      kind: 'chips';
      /** Every chip understood. */
      chips: ChipView[];
      /**
       * What the line tries, widest first (`chipCandidates`): the renderer keeps the first that
       * fits next to `note` in the real font; if none does, it shows no chips.
       */
      candidates: ChipView[][];
      note: LineView | null;
      /**
       * Screen readers, once typing pauses: every chip understood (not only those that fit)
       * and what was not («Entendido: YouTube, 1 h, hasta 18:00»).
       */
      announce: string;
    };

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
  /**
   * «Bloqueando…»: waiting for the guardian. Presses are ignored like `disabled`, but the label
   * is the only sign that a block is being made, so it keeps full contrast.
   */
  busy: boolean;
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
  /** `consequenceAt + 2 s` while locked (`BloqueoView.wakeAt` re-renders then). */
  unlockAt: number | null;
  problem: DraftProblem | null;
  /**
   * Screen readers: what the confirm button commits, read with it (`aria-describedby`):
   * «Bloquea YouTube durante 1 hora, hasta las 18:00, modo Estricto».
   */
  summary: string;
}

/**
 * The undo line. `announce` is spoken once when the line appears (a polite live region of its
 * own); the visible line, with its ticking «Deshacer (4 s)», is never live.
 */
export type UndoView =
  | {
      kind: 'waiting';
      entryId: string;
      text: string;
      button: string;
      buttonLabel: string;
      announce: string;
    }
  | { kind: 'sending'; entryId: string; text: string; announce: null }
  | { kind: 'failed'; entryId: string; text: string; button: string; announce: string };

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

/**
 * The «Límite diario» card (ARCHITECTURE §5.10): what is limited, «30 min al día», the days,
 * Normal | Estricto | Hardcore, «Tu motivo» and Editar… | Crear límite: 30 min al día.
 */
export interface LimitCardView {
  kind: 'limit-card';
  status: 'edit' | 'consequence' | 'sending';
  editable: boolean;
  composer: { value: string } | null;
  chips: ChipView[];
  modes: TileView[];
  modeHelp: string;
  reason: string;
  actions: CardActionView[];
  actionsHelp: CardLine;
  unlockAt: number | null;
  problem: LimitProblem | null;
  /** Screen readers: «Limita YouTube a 30 minutos al día, todos los días, modo Estricto». */
  summary: string;
}

export type BloqueoBody = ComposerBody | CardView | ActiveView | LimitCardView;

export interface BloqueoView {
  variant: BloqueoVariant;
  header: HeaderView;
  body: BloqueoBody;
  /**
   * The next instant after `nowMs` when a label changes off the wall-clock second: «Sí,
   * bloquear 6 h» unlocking, «Deshacer (4 s)» and «Emergencia: 8:12» (each counts down to its
   * own target). The section re-renders exactly then; `null` when nothing waits.
   */
  wakeAt: number | null;
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

/** Header names of what a block blocks, with categories shortened («Redes», «Vídeo»). */
function shortTargetNames(block: Block): string[] {
  if (block.whitelistOnly) return [BLOQUEO.header.whitelistShort];
  const short = { ...block.targets, categoryIds: [] };
  const categories = block.targets.categoryIds.map((id) => BLOQUEO.header.categoryShort[id] ?? id);
  // `targetNames` order: services, categories, apps, custom domains, custom processes.
  const names = targetNames(short, false);
  const services = block.targets.serviceIds.length;
  return [...names.slice(0, services), ...categories, ...names.slice(services)];
}

/** «YouTube +2» from a list of names (one name shown). */
function firstPlus(names: readonly string[]): string {
  const [first = SHARED.targets.none, ...rest] = names;
  return rest.length > 0 ? `${first} ${SHARED.targets.more(rest.length)}` : first;
}

/**
 * Header titles for a block, longest first; every one keeps «Cosa:» («Bloqueo:», «Castigo:»).
 * The section shows the longest one that fits next to its datum and pill in the real font
 * (measured at layout time) and, if not even the last fits, lets the header wrap:
 * «Bloqueo: YouTube, Instagram · Estricto», «Bloqueo: YouTube +1 · Estricto»,
 * «Bloqueo: Redes +2 · Estricto», «Bloqueo: 3 · Estricto» (or «Bloqueo: Estricto»).
 */
export function blockTitles(
  block: Block,
  punishment: Punishment | null,
  limitName: string | null = null,
): string[] {
  if (limitName !== null) {
    // «Límite diario de YouTube: bloqueado hasta las 00:00» (the time is in the title).
    const clock = formatClock(Date.parse(block.endsAt));
    return [
      LIMIT_TEXT.blockCard(limitName, clock),
      BLOQUEO.header.limitNamed(limitName, clock),
      BLOQUEO.header.limitUntil(clock),
    ];
  }
  if (punishment) {
    const level = BLOQUEO.punishment.level[punishment.level];
    return [
      BLOQUEO.header.punishment(level, punishment.minutes),
      BLOQUEO.header.punishmentShort(level),
      BLOQUEO.header.punishmentShort(`${punishment.minutes} min`),
    ];
  }
  const mode = modeLabel(block.mode);
  const count = targetNames(block.targets, block.whitelistOnly).length;
  const titles = [
    BLOQUEO.header.active(targetsLabel(block.targets, block.whitelistOnly, 2), mode),
    BLOQUEO.header.active(targetsLabel(block.targets, block.whitelistOnly, 1), mode),
    BLOQUEO.header.active(firstPlus(shortTargetNames(block)), mode),
    count > 1 ? BLOQUEO.header.activeCount(count, mode) : BLOQUEO.header.activeMode(mode),
  ];
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
      const limitName = !punishment && isLimitBlock(block) ? limitBlockName(state, block) : null;
      const datum =
        variant === 'boot-hold' || limitName !== null
          ? null
          : untilShort(Date.parse(block.endsAt), nowMs);
      const titles = blockTitles(block, punishment, limitName);
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
      title: BLOQUEO.header.finished,
      titles: [BLOQUEO.header.finished],
      datum:
        points !== 0
          ? BLOQUEO.header.finishedPoints(formatPoints(points, { signed: true }))
          : BLOQUEO.header.finishedNoPoints,
      datumTone: points >= 0 ? 'green' : 'default',
      newPill: false,
    };
  }
  const next = state?.nextSchedule ?? null;
  return {
    title: BLOQUEO.header.none,
    titles: [BLOQUEO.header.none],
    datum: next ? BLOQUEO.header.nextSchedule(whenLabel(Date.parse(next.startsAt), nowMs)) : null,
    datumTone: 'default',
    newPill: false,
  };
}

// ---------------------------------------------------------------------------------------
// Composer: field, chips and templates
// ---------------------------------------------------------------------------------------

/** The example phrase shown while the field is empty (`floor(now / 4 s)`: deterministic). */
export function examplePhrase(nowMs: number, rotateMs: number = 4_000): string {
  const list = BLOQUEO.field.examples;
  const index = Math.floor(nowMs / rotateMs) % list.length;
  return list[index] ?? list[0] ?? '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function fieldLine(text: string, nowMs: number, enter: FieldEnter['kind']): FieldLine {
  if (text.trim() === '') return { kind: 'hint', text: BLOQUEO.field.hint };
  const parse = parsePhrase(text, nowMs);
  const chips = typingChips(parse, nowMs);
  let note: LineView | null = null;
  if (parse.unparsed.length > 0) {
    note = {
      tone: 'muted',
      text: BLOQUEO.field.notUnderstood(parse.unparsed.map((f) => truncate(f, 28))),
    };
  } else if (chips.length === 0) {
    note = { tone: 'muted', text: BLOQUEO.field.notUnderstoodAll(truncate(text.trim(), 40)) };
  } else if (enter === 'bloqueos' && parse.kind === 'limit') {
    const hasTargets = chips.some((c) => c.kind !== 'daily' && c.kind !== 'days');
    note = !hasTargets
      ? { tone: 'muted', text: BLOQUEO.field.missingLimitTargets }
      : parse.dailyMinutes === undefined
        ? { tone: 'muted', text: BLOQUEO.field.missingDaily }
        : null;
  } else if (enter === 'bloqueos') {
    const hasTargets = chips.some(
      (c) => c.kind !== 'duration' && c.kind !== 'until' && c.kind !== 'task',
    );
    const hasTime = chips.some((c) => c.kind === 'duration' || c.kind === 'until');
    note = !hasTargets
      ? { tone: 'muted', text: BLOQUEO.field.missingTargets }
      : !hasTime
        ? { tone: 'muted', text: BLOQUEO.field.missingDuration }
        : null;
  }
  const understood = chips.length > 0 ? BLOQUEO.field.understood(chips.map((c) => c.label)) : '';
  const announce = [understood, note?.text ?? ''].filter((t) => t !== '').join('. ');
  return { kind: 'chips', chips, candidates: chipCandidates(chips), note, announce };
}

function templateHelp(template: BlockTemplate, prefs: UiPrefs): string {
  const mode = template.mode ?? prefs.defaultMode;
  const modeText =
    template.mode === null ? BLOQUEO.templates.modeFromSettings(modeLabel(mode)) : modeLabel(mode);
  for (const names of [2, 1]) {
    const text = BLOQUEO.templates.help(
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
  const labels = [...shown.map((t) => templateLabel(t)), BLOQUEO.templates.more];
  const mnemonics = assignMnemonics(labels, [...reservedMnemonics(), ...taken]);
  const tiles: TemplateTileView[] = [
    ...shown.map((t, i) => ({
      ...tile({
        id: t.id,
        label: templateLabel(t),
        help: templateHelp(t, snapshot.prefs),
        mnemonic: mnemonics[i] ?? null,
      }),
      templateId: t.id,
    })),
    {
      ...tile({
        id: 'more',
        label: BLOQUEO.templates.more,
        help: BLOQUEO.templates.moreHelp,
        door: true,
        mnemonic: mnemonics[shown.length] ?? null,
      }),
      templateId: null,
    },
  ];
  return {
    tiles,
    help: rowHelp(help, BLOQUEO_ROWS.templates, tiles, BLOQUEO.templates.rowHelp),
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
    placeholder: BLOQUEO.field.placeholder(examplePhrase(nowMs)),
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

/** «Bloquea YouTube e Instagram durante 1 hora, hasta las 18:00, modo Estricto». */
function cardSummary(draft: BlockDraft, minutes: number, endsAtMs: number, nowMs: number): string {
  const names = draft.whitelistOnly
    ? [BLOQUEO.card.summaryWhitelist]
    : targetNames(draft.targets, false);
  const duration = BLOQUEO.card.durationWords(Math.floor(minutes / 60), minutes % 60);
  const until = untilPhrase(endsAtMs, nowMs);
  const mode = modeLabel(draft.mode);
  return names.length === 0
    ? BLOQUEO.card.summaryNoTargets(duration, until, mode)
    : BLOQUEO.card.summary(formatList(names), duration, until, mode);
}

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
      help: BLOQUEO.card.modeHelp[mode],
      selected: draft.mode === mode,
      accent: modeAccent(mode),
      disabled: !editable,
      disabledReason: !editable ? BLOQUEO.card.pendingHelp : null,
    }),
  );
  const modeHelp = rowHelp(main.help, BLOQUEO_ROWS.modes, modes, BLOQUEO.card.modeHelp[draft.mode]);

  const edit: CardActionView = {
    id: 'edit',
    label: BLOQUEO.card.edit,
    help: BLOQUEO.card.editHelp2,
    primary: false,
    disabled: !editable,
    locked: false,
    busy: false,
    span: 1,
  };
  let actions: CardActionView[];
  if (status === 'pending') {
    actions = [
      edit,
      {
        id: 'confirm',
        label: BLOQUEO.card.pending,
        help: BLOQUEO.card.pendingHelp,
        primary: true,
        disabled: true,
        locked: false,
        busy: true,
        span: 3,
      },
    ];
  } else if (status === 'failed' && unresponsive) {
    actions = [
      {
        id: 'repair',
        label: BLOQUEO.card.repair,
        help: BLOQUEO.card.repairHelp,
        primary: false,
        disabled: false,
        locked: false,
        busy: false,
        span: 1,
      },
      {
        id: 'retry',
        label: BLOQUEO.card.retry,
        help: BLOQUEO.card.retryHelp,
        primary: true,
        disabled: false,
        locked: false,
        busy: false,
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
          ? BLOQUEO.card.confirmAgain(durationLabel(minutes))
          : BLOQUEO.card.confirm(untilShort(endsAtMs, nowMs)),
        help: consequence ? BLOQUEO.card.confirmAgainHelp : BLOQUEO.card.confirmHelp,
        primary: true,
        disabled: problem !== null || !editable,
        locked,
        busy: false,
        span: 3,
      },
    ];
  }

  // Alt + letter, unique among the card's tiles (modes first, then the actions).
  const letters = assignMnemonics(
    [...modes.map((m) => m.label), ...actions.map((a) => a.label)],
    reservedMnemonics(),
  );
  modes.forEach((m, i) => {
    m.mnemonic = letters[i] ?? null;
  });
  actions = actions.map((a, i) => ({ ...a, mnemonic: letters[modes.length + i] ?? null }));

  let actionsHelp: CardLine;
  if (failedError) {
    actionsHelp = { kind: 'error', error: failedError };
  } else if (card?.editing) {
    actionsHelp = { kind: 'text', tone: 'muted', text: BLOQUEO.card.editHelp };
  } else if (problem && status !== 'pending') {
    actionsHelp = { kind: 'text', tone: 'orange', text: BLOQUEO.card.problem[problem] };
  } else if (status === 'consequence') {
    const noEmergency = draft.mode === 'hardcore' || draft.mode === 'exam';
    actionsHelp = {
      kind: 'text',
      tone: 'red',
      text: noEmergency
        ? BLOQUEO.card.consequenceNoEmergency(untilPhrase(endsAtMs, nowMs))
        : BLOQUEO.card.consequenceLong(durationLabel(minutes), endsPhrase(endsAtMs, nowMs)),
    };
  } else {
    const hovered =
      main.help?.row === BLOQUEO_ROWS.actions
        ? actions.find((a) => a.id === main.help?.item)
        : undefined;
    actionsHelp = {
      kind: 'text',
      tone: 'muted',
      text: hovered && status !== 'pending' ? hovered.help : BLOQUEO.card.reminder,
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
    summary: cardSummary(draft, minutes, endsAtMs, nowMs),
  };
}

// ---------------------------------------------------------------------------------------
// The «Límite diario» card
// ---------------------------------------------------------------------------------------

const LIMIT_MODE_ORDER: readonly LimitMode[] = LIMIT_MODES;

function limitCardView(main: MainLocalState, nowMs: number): LimitCardView {
  const card = main.limitCard;
  if (!card) throw new Error('limitCardView without a limit card');
  const draft = card.draft;
  const L = BLOQUEO.limit;
  const status: LimitCardView['status'] = card.sending
    ? 'sending'
    : card.step === 'consequence'
      ? 'consequence'
      : 'edit';
  const editable = !card.sending;
  const problem = limitProblem(draft);
  const perDay = LIMIT_TEXT.perDay(draft.dailyMinutes);

  const modes = LIMIT_MODE_ORDER.map((mode) =>
    tile({
      id: mode,
      label: modeLabel(mode),
      help: L.modeHelp[mode],
      selected: draft.mode === mode,
      accent: modeAccent(mode),
      disabled: !editable,
      disabledReason: !editable ? L.sendingHelp : null,
    }),
  );
  const modeHelp = rowHelp(main.help, BLOQUEO_ROWS.modes, modes, L.modeHelp[draft.mode]);

  const unlockAt = limitUnlockAt(card);
  const locked = status === 'consequence' && unlockAt !== null && nowMs < unlockAt;
  let actions: CardActionView[] = [
    {
      id: 'edit',
      label: L.edit,
      help: L.editHelp,
      primary: false,
      disabled: !editable,
      locked: false,
      busy: false,
      span: 1,
    },
    {
      id: 'confirm',
      label:
        status === 'sending'
          ? L.sending
          : status === 'consequence'
            ? L.confirmAgain
            : L.confirm(perDay),
      help:
        status === 'sending'
          ? L.sendingHelp
          : status === 'consequence'
            ? L.confirmAgainHelp
            : L.confirmHelp,
      primary: true,
      disabled: problem !== null,
      locked,
      busy: status === 'sending',
      span: 3,
    },
  ];
  const letters = assignMnemonics(
    [...modes.map((m) => m.label), ...actions.map((a) => a.label)],
    // The Progreso doors keep their letters too (the card sits above them).
    [...reservedMnemonics(), ...progresoMnemonics()],
  );
  modes.forEach((m, i) => {
    m.mnemonic = letters[i] ?? null;
  });
  actions = actions.map((a, i) => ({ ...a, mnemonic: letters[modes.length + i] ?? null }));

  let actionsHelp: CardLine;
  if (card.error) {
    actionsHelp = { kind: 'error', error: card.error };
  } else if (problem) {
    actionsHelp = { kind: 'text', tone: 'orange', text: L.problem[problem] };
  } else if (status === 'consequence') {
    actionsHelp = { kind: 'text', tone: 'red', text: L.consequence };
  } else if (status === 'sending') {
    actionsHelp = { kind: 'text', tone: 'muted', text: L.sendingHelp };
  } else {
    const hovered =
      main.help?.row === BLOQUEO_ROWS.actions
        ? actions.find((a) => a.id === main.help?.item)
        : undefined;
    actionsHelp = {
      kind: 'text',
      tone: 'muted',
      text: hovered ? hovered.help : L.reminder(durationLabel(draft.dailyMinutes)),
    };
  }

  const names = targetNames(draft.targets, false);
  return {
    kind: 'limit-card',
    status,
    editable,
    composer:
      card.phrase !== null && main.composer.text !== '' ? { value: main.composer.text } : null,
    chips: limitChips(draft),
    modes,
    modeHelp,
    reason: draft.reason,
    actions,
    actionsHelp,
    unlockAt,
    problem,
    summary: L.summary(
      formatList(names),
      BLOQUEO.card.durationWords(Math.floor(draft.dailyMinutes / 60), draft.dailyMinutes % 60),
      LIMIT_TEXT.days(draft.days),
      modeLabel(draft.mode),
    ),
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
  return BLOQUEO.active.plus(durationLabel(minutes));
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
      const ends = endsPhrase(Date.parse(pick.projectedEndsAt), nowMs);
      return {
        kind: 'waiting',
        entryId: pick.id,
        text: BLOQUEO.active.undoLine(plus, ends),
        button: BLOQUEO.active.undo(seconds),
        buttonLabel: BLOQUEO.active.undoLabel(plus),
        announce: BLOQUEO.active.undoAnnounce(
          plus,
          ends,
          Math.round(UI_TIMINGS.extendUndoMs / 1000),
        ),
      };
    }
    case 'sending':
      return {
        kind: 'sending',
        entryId: pick.id,
        text: BLOQUEO.active.sending(plus),
        announce: null,
      };
    case 'failed':
      return {
        kind: 'failed',
        entryId: pick.id,
        text: BLOQUEO.active.failed,
        button: BLOQUEO.card.retry,
        announce: BLOQUEO.active.failedAnnounce,
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
      help: BLOQUEO.active.extendTileHelp(plus, endsPhrase(projectedEnd(base, minutes), nowMs)),
      disabled: minutes > max,
      disabledReason: minutes > max ? BLOQUEO.active.maxReached : null,
    });
  });
  tiles.push(
    tile({
      id: 'other',
      label: BLOQUEO.active.other,
      help: BLOQUEO.active.otherHelp,
      door: true,
      disabled: max < 1,
      disabledReason: max < 1 ? BLOQUEO.active.maxReached : null,
    }),
  );
  EXTEND_MNEMONICS.forEach((key, i) => {
    const t = tiles[i];
    if (t) t.mnemonic = key;
  });

  const text = main.extendOther.text;
  const minutes = parseExtendMinutes(text, nowMs);
  let line: LineView;
  if (text.trim() === '') line = { tone: 'muted', text: BLOQUEO.active.otherHelpLabel };
  else if (minutes === null) line = { tone: 'orange', text: BLOQUEO.active.otherInvalid };
  else if (minutes > max) {
    line = {
      tone: 'orange',
      text: BLOQUEO.active.otherTooMuch(durationLabel(Math.max(0, max))),
    };
  } else {
    line = {
      tone: 'muted',
      text: BLOQUEO.active.undoLine(
        plusLabel(minutes),
        endsPhrase(projectedEnd(base, minutes), nowMs),
      ),
    };
  }

  return {
    blockId: block.id,
    tiles,
    help: rowHelp(main.help, BLOQUEO_ROWS.extend, tiles, BLOQUEO.active.extendHelp),
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

/**
 * Alt + 5, 0, h, o: each an underlined character of «+15 min», «+30 min», «+1 h», «Otro…».
 * No digit of the Ctrl+E chord (1 +15 min, 2 +30 min, 3 +1 h, 4 Otro…), so Alt+<digit> can
 * never name a different amount than Ctrl+E <digit>.
 */
const EXTEND_MNEMONICS = ['5', '0', 'h', 'o'] as const;

const ROW_COUNTDOWN_WIDTH = 64 + 12; // «2:10:05» at 13 px tabular + gap.

function rowView(state: GuardianStateResponse, block: Block): RowView {
  const punishment = block.kind === 'punishment' ? punishmentOf(state, block) : null;
  const mode = punishment
    ? BLOQUEO.header.punishment(BLOQUEO.punishment.level[punishment.level], punishment.minutes)
    : null;
  let label = mode ?? '';
  if (!mode && isLimitBlock(block)) {
    label = BLOQUEO.active.row(
      BLOQUEO.header.limitShort(limitBlockName(state, block)),
      modeLabel(block.mode),
    );
  } else if (!mode) {
    const budget = CONTENT_WIDTH - ROW_COUNTDOWN_WIDTH - 12;
    for (const names of [2, 1]) {
      label = BLOQUEO.active.row(
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
          ? BLOQUEO.active.emergencyReady
          : BLOQUEO.active.emergencyCounting(
              splitCountdown(Date.parse(emergency.readyAt) - nowMs).text,
            ),
      help: BLOQUEO.active.emergencyHelp,
      request,
    };
  }
  if (block.emergencyEligible) {
    return {
      kind: 'link',
      label: BLOQUEO.active.emergency,
      help: BLOQUEO.active.emergencyHelp,
      request,
    };
  }
  if (block.mode === 'hardcore' || block.mode === 'exam') {
    return { kind: 'text', label: BLOQUEO.active.noEmergency[block.mode] };
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
    bootHold: bootHold ? BLOQUEO.active.bootHold : null,
    bar: {
      accent: punishment ? 'red' : modeAccent(block.mode),
      // Boot hold: the time is unknown, so the bar stays an empty track (never "full").
      value: bootHold ? 0 : elapsedFraction(block, nowMs),
    },
    reason: !punishment ? fitReason(block.reason, emergency) : null,
    punishment: punishment
      ? {
          cause: BLOQUEO.punishment.cause(punishment.cause, punishment.task),
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
            label: BLOQUEO.active.more(others.length - 2),
            help: BLOQUEO.active.moreHelp,
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
// Wake-ups
// ---------------------------------------------------------------------------------------

/**
 * The next instant after `nowMs` when a whole-second countdown to `targetMs` (rounded up, like
 * `splitCountdown` and «Deshacer (N s)») shows a new value; `null` once it is reached.
 */
export function nextSecondChange(targetMs: number, nowMs: number): number | null {
  const left = targetMs - nowMs;
  if (!(left > 0)) return null;
  const into = left % 1000;
  return nowMs + (into === 0 ? 1000 : into);
}

function viewWakeAt(snapshot: UiSnapshot, body: BloqueoBody, nowMs: number): number | null {
  const at: number[] = [];
  const add = (ms: number | null): void => {
    if (ms !== null && ms > nowMs) at.push(ms);
  };
  if (body.kind === 'card' || body.kind === 'limit-card') add(body.unlockAt);
  if (body.kind === 'active') {
    const undo = body.extend?.undo;
    if (undo?.kind === 'waiting') {
      const entry = snapshot.ops.extendQueue.find((e) => e.id === undo.entryId);
      if (entry) add(nextSecondChange(entry.commitAt, nowMs));
    }
    const emergency = snapshot.state?.emergency;
    if (body.emergency?.kind === 'link' && emergency?.status === 'counting') {
      add(nextSecondChange(Date.parse(emergency.readyAt), nowMs));
    }
  }
  return at.length > 0 ? Math.min(...at) : null;
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
    case 'limit':
      body = limitCardView(main, nowMs);
      break;
    case 'active':
    case 'punishment':
    case 'boot-hold':
      body = activeView(variant, snapshot, main, nowMs);
      break;
  }
  return { variant, header, body, wakeAt: viewWakeAt(snapshot, body, nowMs) };
}
