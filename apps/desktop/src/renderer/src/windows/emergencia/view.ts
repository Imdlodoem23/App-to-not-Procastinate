/**
 * View model of the Emergencia window (PROMPT §7 «Desbloqueo de emergencia», §10 «Ventanas de
 * detalle › Emergencia»; docs/DESKTOP.md §7.7), pure. Stages:
 *
 * - `request`: what you would lose, already priced by the guardian's preview («Perderás 620
 *   puntos y tu racha de 5 días»), the blocks it cancels and the ones that stay (Hardcore,
 *   Examen), and the commitment phrase typed by hand;
 * - `unavailable`: Hardcore and Examen say why there is no way out («Hardcore: no se puede
 *   cancelar de ninguna forma hasta las 18:42»);
 * - `counting`: «Esperando · 8:12 · Cancelar (recomendado)» in orange (`state.emergency`);
 * - `ready`: «Desbloquear» with the in-place «¿Seguro?», before the confirm window closes;
 * - `done`: what was cancelled and charged.
 *
 * Until the guardian's preview arrives the same numbers are computed locally with the shared
 * rules (`emergencyPenalty`, `emergencyCountdownMinutes`), so the window never flashes empty;
 * the guardian's answer replaces them.
 */
import type { Accent } from '@centrate/shared/design/tokens';
import type { Block, BlockId, EmergencyId } from '@centrate/shared/domain';
import type {
  EmergencyPreviewResponse,
  GuardianStateResponse,
} from '@centrate/shared/guardian-api';
import { activeLocale, localized } from '../../../../shared/i18n/locale';
import {
  EMERGENCY_RULES,
  emergencyCountdownMinutes,
  emergencyPenalty,
  emergencyPhraseMatches,
  normalizePhrase,
} from '@centrate/shared/points';
import {
  formatClock,
  formatPoints,
  formatWeekday,
  modeLabel,
  targetsLabel,
} from '../../../../shared/format';
import { modeAccent, type UiState } from '../../../../shared/ui-state';
import { EMERGENCIA } from './i18n';

const E = EMERGENCIA;

export const EMERGENCIA_IDS = {
  section: 'emg',
  phrase: 'emg-phrase',
  phraseHelp: 'emg-phrase-help',
  row: 'emg-actions',
} as const;

/** Armed id of «Desbloquear» (fixture `emergency-ready`). */
export const UNLOCK_ARM_ID = 'emergency-unlock';

/**
 * Alt + letter of every tile, per language (unique in the window; the letter is in the label).
 * Alt + D only arms «Desbloquear», like a first click: a second press within 3 s confirms.
 */
export const EMERGENCIA_KEYS: Readonly<
  Record<'stay' | 'request' | 'cancel' | 'unlock' | 'close', string>
> = localized({
  es: { stay: 's', request: 'e', cancel: 'c', unlock: 'd', close: 'r' },
  en: { stay: 's', request: 'w', cancel: 'c', unlock: 'u', close: 'l' },
});

/** Row item ids, so a stage can focus its recommended control. */
export const EMERGENCIA_TILES = {
  stay: 'stay',
  request: 'request',
  cancel: 'cancel',
  unlock: 'unlock',
  close: 'close',
} as const;

export type EmergenciaStage = 'request' | 'unavailable' | 'counting' | 'ready' | 'done';
export type PhraseStatus = 'empty' | 'typing' | 'mismatch' | 'ok';

export interface EmergencyBlockRow {
  id: BlockId;
  label: string;
  until: string;
  tone: Accent;
  fate: 'cancels' | 'stays';
  fateText: string;
}

export interface EmergenciaView {
  stage: EmergenciaStage;
  title: string;
  datum: string | null;
  datumTone: 'muted' | 'red' | 'orange';
  /** «Perderás 620 puntos y tu racha de 5 días» (`null` when nothing can be lost). */
  loss: string | null;
  rows: EmergencyBlockRow[];
  /** `request` only. */
  phrase: {
    target: string;
    status: PhraseStatus;
    help: string;
    tone: 'muted' | 'orange' | 'green';
  } | null;
  /** `request` only: what «Empezar la espera» sends. */
  request: {
    label: string;
    blockIds: BlockId[];
    disabledReason: string | null;
  } | null;
  /** `counting` / `ready`. */
  emergency: {
    id: EmergencyId;
    readyAtMs: number;
    requestedAtMs: number;
    confirmByMs: number | null;
    /** Share of the countdown already waited (0..1). */
    progress: number;
  } | null;
  /** `unavailable` only. */
  unavailable: string | null;
  /** `done` only. */
  done: { cancelled: string; lost: string; balance: string } | null;
  /** Where the prices come from (the guardian's preview replaces the local estimate). */
  source: 'guardian' | 'local';
}

/**
 * What a new stage says to screen readers: the section title and its datum («Emergencia:
 * esperando, lista a las 17:08»), plus what was cancelled once done. `notice` (a result that
 * caused the change: «Cancelada: no has perdido nada») goes first.
 */
export function stageAnnouncement(view: EmergenciaView, notice: string | null = null): string {
  const parts = [E.announce.stage(view.title, view.datum)];
  if (view.done) parts.push(view.done.cancelled);
  if (notice) parts.unshift(notice);
  return parts.join('. ');
}

/** The tile a stage focuses: always the way that keeps the block («Cerrar» at the end). */
export function stageFocus(stage: EmergenciaStage): 'phrase' | keyof typeof EMERGENCIA_TILES {
  switch (stage) {
    case 'request':
      return 'phrase';
    case 'counting':
    case 'ready':
      return 'cancel';
    case 'unavailable':
    case 'done':
      return 'close';
  }
}

/** «hasta las 18:42», «hasta mañana a las 08:00». */
export function untilPhrase(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  const day = (x: number): number => {
    const d = new Date(x);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = Math.round(day(ms) - day(nowMs));
  if (days <= 0) return E.until.today(time);
  if (days === 1) return E.until.tomorrow(time);
  return E.until.later(formatWeekday(ms), time);
}

/** How the typed phrase compares with the commitment phrase (shared normalization). */
export function phraseStatus(typed: string): PhraseStatus {
  if (normalizePhrase(typed) === '') return 'empty';
  if (emergencyPhraseMatches(typed)) return 'ok';
  const t = normalizePhrase(typed);
  const prefix = Object.values(EMERGENCY_RULES.phrases).some((p) =>
    normalizePhrase(p).startsWith(t),
  );
  return prefix ? 'typing' : 'mismatch';
}

/**
 * The preview the guardian would answer, computed from the snapshot with the shared rules
 * (without reward allowances, which only the guardian knows).
 */
export function localPreview(
  state: GuardianStateResponse,
  blockIds: readonly BlockId[] | null,
): EmergencyPreviewResponse {
  const scope = blockIds ? state.blocks.filter((b) => blockIds.includes(b.id)) : state.blocks;
  const eligible = scope.filter((b) => b.emergencyEligible);
  const excluded = state.blocks.filter(
    (b) => (b.mode === 'hardcore' || b.mode === 'exam') && b.kind !== 'punishment',
  );
  const inProgress = state.emergency !== null;
  let reason: EmergencyPreviewResponse['reason'] = null;
  if (inProgress) reason = 'emergency_in_progress';
  else if (eligible.length === 0) {
    if (scope.length === 0) reason = 'no_active_blocks';
    else reason = scope.some((b) => b.mode === 'hardcore') ? 'hardcore' : 'exam';
  }
  return {
    eligible: reason === null,
    reason,
    blockIds: reason === null ? eligible.map((b) => b.id) : [],
    excludedBlockIds: excluded.map((b) => b.id),
    countdownMinutes: emergencyCountdownMinutes(eligible.map((b) => b.mode)),
    penaltyPoints: emergencyPenalty(state.points.balance),
    balance: state.points.balance,
    allowanceValue: 0,
    streakDays: state.points.streakDays,
    phrases: { ...EMERGENCY_RULES.phrases },
  };
}

function lossText(points: number, streakDays: number): string {
  return E.loss(formatPoints(points), streakDays);
}

function blockRow(block: Block, fate: 'cancels' | 'stays', nowMs: number): EmergencyBlockRow {
  return {
    id: block.id,
    label: E.row(targetsLabel(block.targets, block.whitelistOnly, 2), modeLabel(block.mode)),
    until: untilPhrase(Date.parse(block.endsAt), nowMs),
    tone: modeAccent(block.mode),
    fate,
    fateText: fate === 'cancels' ? E.cancels : E.stays,
  };
}

function rowsFor(
  state: GuardianStateResponse,
  cancels: readonly BlockId[],
  nowMs: number,
): EmergencyBlockRow[] {
  const set = new Set<string>(cancels);
  const first = state.blocks.filter((b) => set.has(b.id)).map((b) => blockRow(b, 'cancels', nowMs));
  const rest = state.blocks.filter((b) => !set.has(b.id)).map((b) => blockRow(b, 'stays', nowMs));
  return [...first, ...rest];
}

function base(stage: EmergenciaStage, title: string): EmergenciaView {
  return {
    stage,
    title,
    datum: null,
    datumTone: 'muted',
    loss: null,
    rows: [],
    phrase: null,
    request: null,
    emergency: null,
    unavailable: null,
    done: null,
    source: 'local',
  };
}

function unavailableText(
  state: GuardianStateResponse | null,
  reason: EmergencyPreviewResponse['reason'],
  nowMs: number,
): string {
  if ((reason === 'hardcore' || reason === 'exam') && state) {
    const block =
      state.blocks.find((b) => b.mode === reason) ??
      state.blocks.find((b) => b.mode === 'hardcore' || b.mode === 'exam');
    if (block) {
      return E.unavailable.noEmergency(
        modeLabel(block.mode),
        untilPhrase(Date.parse(block.endsAt), nowMs),
      );
    }
  }
  return E.unavailable.none;
}

export function deriveEmergenciaView(
  state: UiState,
  nowMs: number,
  guardianPreview: EmergencyPreviewResponse | null,
): EmergenciaView {
  const local = state.detail.emergencia;
  const guardian = state.snapshot.state;

  if (local.result) {
    const r = local.result;
    const view = base('done', E.title.done);
    return {
      ...view,
      datum: formatPoints(-r.penaltyApplied, { signed: true }),
      datumTone: 'red',
      done: {
        cancelled: E.done.cancelled(r.cancelledBlockIds.length),
        lost: E.done.lost(formatPoints(r.penaltyApplied), r.streakDaysLost),
        balance: E.done.balance(formatPoints(r.balanceAfter)),
      },
      source: 'guardian',
    };
  }

  const emergency = guardian?.emergency ?? null;
  if (guardian && emergency && (emergency.status === 'counting' || emergency.status === 'ready')) {
    const readyAtMs = Date.parse(emergency.readyAt);
    const requestedAtMs = Date.parse(emergency.requestedAt);
    const confirmByMs = emergency.confirmBy ? Date.parse(emergency.confirmBy) : null;
    const span = Math.max(1, readyAtMs - requestedAtMs);
    const counting = emergency.status === 'counting';
    const view = base(counting ? 'counting' : 'ready', counting ? E.title.counting : E.title.ready);
    return {
      ...view,
      datum: counting
        ? E.readyAt(formatClock(readyAtMs))
        : confirmByMs !== null
          ? E.deadline(formatClock(confirmByMs))
          : null,
      datumTone: counting ? 'muted' : 'orange',
      loss: lossText(emergency.penaltyPreview, emergency.streakDaysAtRisk),
      rows: rowsFor(guardian, emergency.blockIds, nowMs),
      emergency: {
        id: emergency.id,
        readyAtMs,
        requestedAtMs,
        confirmByMs,
        progress: Math.min(1, Math.max(0, (nowMs - requestedAtMs) / span)),
      },
      source: 'guardian',
    };
  }

  if (!guardian) {
    const view = base('unavailable', E.title.unavailable);
    return { ...view, unavailable: E.unavailable.none };
  }

  const usable =
    guardianPreview && !(guardianPreview.reason === 'emergency_in_progress' && !emergency)
      ? guardianPreview
      : null;
  const preview = usable ?? localPreview(guardian, local.blockIds);
  const source = usable ? 'guardian' : 'local';

  if (!preview.eligible) {
    const view = base('unavailable', E.title.unavailable);
    return {
      ...view,
      rows: guardian.blocks.map((b) => blockRow(b, 'stays', nowMs)),
      unavailable: unavailableText(guardian, preview.reason, nowMs),
      source,
    };
  }

  const cancels = guardian.blocks.filter((b) => preview.blockIds.includes(b.id));
  const only = cancels.length === 1 ? cancels[0] : undefined;
  const what = only
    ? targetsLabel(only.targets, only.whitelistOnly, 2)
    : E.blocks(preview.blockIds.length);
  const minutes = preview.countdownMinutes ?? EMERGENCY_RULES.countdownMinutes.normal;
  const status = phraseStatus(local.phrase);
  const phraseHelp: Record<PhraseStatus, { help: string; tone: 'muted' | 'orange' | 'green' }> = {
    empty: { help: E.phrase.empty, tone: 'muted' },
    typing: { help: E.phrase.typing, tone: 'muted' },
    mismatch: { help: E.phrase.mismatch, tone: 'orange' },
    ok: { help: E.phrase.ok, tone: 'green' },
  };
  const view = base('request', E.title.request(what));
  return {
    ...view,
    datum: E.wait(minutes),
    datumTone: 'muted',
    loss: lossText(preview.penaltyPoints, preview.streakDays),
    rows: rowsFor(guardian, preview.blockIds, nowMs),
    phrase: { target: preview.phrases[activeLocale()], status, ...phraseHelp[status] },
    request: {
      label: E.actions.request(minutes),
      blockIds: [...preview.blockIds],
      disabledReason: status === 'ok' ? null : E.actions.requestDisabled,
    },
    source,
  };
}
