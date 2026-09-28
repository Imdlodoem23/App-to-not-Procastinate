/**
 * The desktop UI state model (docs/DESKTOP.md §5). Everything a window shows is a function
 * of one serialisable `UiState`:
 *
 * - `snapshot` (`UiSnapshot`): owned by the **main process**. The last good guardian
 *   `/v1/state`, the guardian link, operations in flight (the «Bloqueando…» create, the
 *   5 s extend queue), app preferences, templates and feature flags. Main pushes it whole
 *   to every window whenever `rev` changes; renderers never edit it.
 * - `main` / `detail` (`MainLocalState`, `DetailLocalState`): owned by each **renderer**.
 *   Text being typed, the confirmation card, the armed «¿Seguro?», the detail forms. Only
 *   state a harness fixture must be able to set lives here; purely visual state (hover
 *   animations, focus) stays in components.
 * - `env` (`RenderEnv`): which window this is, its platform, its height budget.
 *
 * Harness fixtures (`fixtures.ts`) are complete `UiState` values, so a screenshot is a
 * `UiState` rendered. Pure module: no DOM, Node or Electron imports; it runs in main,
 * preload, renderers and vitest.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import type { Density, ThemePreference } from '@centrate/shared/design/tokens';
import type {
  Block,
  BlockId,
  BlockMode,
  IsoUtc,
  Punishment,
  TargetSpec,
} from '@centrate/shared/domain';
import type {
  ConfirmEmergencyResponse,
  CreateBlockRequest,
  GuardianStateResponse,
  HealthResponse,
  PairingCodeResponse,
} from '@centrate/shared/guardian-api';
import {
  GUARDIAN_LIMITS,
  GuardianApiError,
  emptyAllow,
  emptyTargets,
} from '@centrate/shared/guardian-api';
import type { ParseResult } from '@centrate/shared/parser';
import { FEATURES, type FeatureFlags } from './features';
import { SHARED_ES } from './i18n/es';

// ---------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------

export type Platform = 'win32' | 'darwin' | 'linux';

/** `process.platform` → `Platform` (anything unknown is treated like Linux). */
export function toPlatform(value: string): Platform {
  return value === 'win32' || value === 'darwin' ? value : 'linux';
}

/** Phase 1 has the main window and one reusable detail window (mini, OSD… come with flags). */
export type WindowKind = 'main' | 'detail';

/** Detail windows of Phase 1. Later: study, resumen, estadisticas, recompensas, logros. */
export const DETAIL_NAMES = ['bloqueos', 'emergencia', 'ajustes'] as const;
export type DetailName = (typeof DETAIL_NAMES)[number];

export function isDetailName(value: unknown): value is DetailName {
  return typeof value === 'string' && (DETAIL_NAMES as readonly string[]).includes(value);
}

/** Groups of the Ajustes window (Study Mode joins with its flag). */
export const AJUSTES_GROUPS = ['general', 'bloqueo', 'sistema', 'datos'] as const;
export type AjustesGroup = (typeof AJUSTES_GROUPS)[number];

/** Which fixed edge a window keeps when its height changes (bottom on Windows, top on macOS). */
export type WindowAnchor = 'top' | 'bottom';

/** Height budget main computes for a window (pushed on show and on display changes). */
export interface WindowLayout {
  /** `workArea.height − 2 × 10 − frame.top − frame.bottom`, in DIP. */
  maxContentHeight: number;
  anchor: WindowAnchor;
}

/** What the main window's renderer reports after measuring itself (§8 «Alto automático»). */
export interface LayoutReport {
  /** Content height in DIP (≤ `maxContentHeight`). */
  height: number;
  density: Density;
  /** True only below the screenshot matrix: the section column scrolls (never the footer). */
  scroll: boolean;
}

// ---------------------------------------------------------------------------------------
// Errors and command results (never throw across IPC)
// ---------------------------------------------------------------------------------------

/** Renderer-generated id of one user intention; main sends it as the `Idempotency-Key`. */
export type IntentId = string;

/** Same rule as the guardian's `Idempotency-Key` (1–128 of `[A-Za-z0-9_.:-]`). */
export const INTENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isIntentId(value: unknown): value is IntentId {
  return typeof value === 'string' && INTENT_ID_RE.test(value);
}

export const UI_ERROR_KINDS = [
  /** No answer within 3 s. */
  'timeout',
  /** Connection refused or reset: the guardian is not running. */
  'unreachable',
  /** `client.json` is missing: the guardian is not installed. */
  'not_installed',
  /** 401 even after re-reading `client.json`. */
  'unauthorized',
  /** `health.apiVersion` is not one the app speaks. */
  'incompatible',
  /** 503 `read_only` (disk full, frozen or safe mode). */
  'read_only',
  /** Any other 4xx: `code` says which (`extension_exceeds_max`, `phrase_mismatch`…). */
  'rejected',
  /** The guardian answered something the validators refused. */
  'invalid_response',
  /** 5xx or a bug in the app. */
  'internal',
] as const;
export type UiErrorKind = (typeof UI_ERROR_KINDS)[number];

/** Serialisable error. The UI maps `code` (or `kind`) to Spanish copy with one action. */
export interface UiError {
  kind: UiErrorKind;
  /** Guardian error code, client error code, or the kind itself. */
  code: string;
  /** HTTP status, 0 without a response. */
  status: number;
  details: Record<string, unknown> | null;
}

export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: UiError };

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: UiError): CommandResult<T> {
  return { ok: false, error };
}

export function uiError(
  kind: UiErrorKind,
  code: string = kind,
  status: number = 0,
  details: Record<string, unknown> | null = null,
): UiError {
  return { kind, code, status, details };
}

/**
 * Maps anything thrown by `GuardianClient` (or a bug) to a `UiError`. Pass
 * `clientJsonMissing` when `client.json` does not exist, so `unreachable` reads as
 * «not installed». Duck-typed so errors that lost their class still map.
 */
export function toUiError(error: unknown, options: { clientJsonMissing?: boolean } = {}): UiError {
  const status =
    error instanceof GuardianApiError
      ? error.status
      : typeof (error as { status?: unknown } | null)?.status === 'number'
        ? (error as { status: number }).status
        : null;
  const code =
    error instanceof GuardianApiError
      ? String(error.code)
      : typeof (error as { code?: unknown } | null)?.code === 'string'
        ? (error as { code: string }).code
        : null;
  if (status === null || code === null) return uiError('internal', 'internal');
  const details =
    error instanceof GuardianApiError
      ? error.details
      : ((error as { details?: Record<string, unknown> | null }).details ?? null);
  if (status === 0) {
    if (code === 'timeout') return uiError('timeout', code, 0, details);
    if (code === 'unreachable') {
      return options.clientJsonMissing
        ? uiError('not_installed', 'not_installed', 0, details)
        : uiError('unreachable', code, 0, details);
    }
    return uiError('invalid_response', code, 0, details);
  }
  if (status === 401) return uiError('unauthorized', code, status, details);
  if (status === 503 && code === 'read_only') return uiError('read_only', code, status, details);
  if (status >= 400 && status < 500) return uiError('rejected', code, status, details);
  return uiError('internal', code, status, details);
}

/** The guardian did not answer: show «El guardián no responde · Reintentar · Reparar». */
export function isGuardianUnresponsive(error: UiError): boolean {
  return error.kind === 'timeout' || error.kind === 'unreachable' || error.kind === 'not_installed';
}

// ---------------------------------------------------------------------------------------
// Guardian link
// ---------------------------------------------------------------------------------------

/**
 * `connecting` until the first answer; `down` only after the retry rule of DESKTOP.md §6.1
 * (never on a single slow response), so section 1 appears ≤ 5 s after a real failure.
 */
export type LinkStatus = 'connecting' | 'ok' | 'down';
export type LinkDownReason =
  'not_installed' | 'unreachable' | 'timeout' | 'unauthorized' | 'incompatible';

export interface GuardianLink {
  status: LinkStatus;
  /** Set exactly when `status` is `down`. */
  reason: LinkDownReason | null;
  /** When `status` last changed (ms). */
  since: number;
  lastOkAt: number | null;
  /** Consecutive failed requests. */
  failures: number;
}

// ---------------------------------------------------------------------------------------
// Drafts, templates and preferences
// ---------------------------------------------------------------------------------------

/** «1 h» (duration) or «hasta las 20:30» (display-time end), kept in sync by the card. */
export type DraftEnd = { kind: 'duration'; minutes: number } | { kind: 'until'; endsAt: IsoUtc };

/** What the confirmation card and the Bloqueos form edit before anything is sent. */
export interface BlockDraft {
  /** Empty when `whitelistOnly`. */
  targets: TargetSpec;
  /** Exam forces it; «Todo salvo la lista blanca». */
  whitelistOnly: boolean;
  /** Targets kept while the mode is Examen, restored when the user switches back. */
  savedTargets: TargetSpec | null;
  mode: BlockMode;
  end: DraftEnd;
  /** «Tu motivo» (≤ 140 UTF-16 units; `''` when none). */
  reason: string;
}

/** What Bloqueos is opened with («con lo que sí entendió»). `null` fields keep form defaults. */
export interface DraftSeed {
  /** The phrase the seed came from, shown above the form. */
  phrase: string | null;
  targets: TargetSpec | null;
  end: DraftEnd | null;
  mode: BlockMode | null;
  reason: string | null;
}

export interface BlockTemplate {
  /** `deberes`, `examen`, `leer` for the built-in ones; `tpl_<uuid>` for the user's. */
  id: string;
  /** «Deberes 1 h» (tile label). */
  label: string;
  builtin: boolean;
  targets: TargetSpec;
  whitelistOnly: boolean;
  /** `null`: the default mode from Ajustes at confirmation time. */
  mode: BlockMode | null;
  durationMinutes: number;
  /** `null`: the last reason. */
  reason: string | null;
}

/** `templates:save`: `id: null` creates a template. */
export type TemplateInput = Omit<BlockTemplate, 'id' | 'builtin'> & { id: string | null };

/** Examen needs a whitelist, so it cannot be the phrase default. */
export type DefaultBlockMode = Exclude<BlockMode, 'exam'>;

/** App-only preferences (the guardian's settings are separate: `GET /v1/settings`). */
export interface UiPrefs {
  v: 1;
  theme: ThemePreference;
  autostart: boolean;
  defaultMode: DefaultBlockMode;
  /** «Tu motivo» remembers the last one. */
  lastReason: string;
  /** The one-time «Céntrate sigue en la bandeja» hint after the first X. */
  closeHintShown: boolean;
  language: 'es';
}

export type UiPrefsPatch = Partial<
  Pick<UiPrefs, 'theme' | 'autostart' | 'defaultMode' | 'lastReason' | 'closeHintShown'>
>;

export const DEFAULT_PREFS: Readonly<UiPrefs> = Object.freeze({
  v: 1,
  theme: 'system',
  autostart: true,
  defaultMode: 'normal',
  lastReason: '',
  closeHintShown: false,
  language: 'es',
});

/** Categories the «Deberes» and «Leer» templates block. */
const STUDY_DISTRACTIONS: readonly CategoryId[] = ['social', 'video', 'games', 'messaging'];

function categoriesTargets(categoryIds: readonly CategoryId[]): TargetSpec {
  return { ...emptyTargets(), categoryIds: [...categoryIds] };
}

/** «Deberes 1 h | Examen 3 h | Leer 30 min» (PROMPT §4, §10). */
export const DEFAULT_TEMPLATES: readonly BlockTemplate[] = Object.freeze([
  {
    id: 'deberes',
    label: SHARED_ES.templates.deberes,
    builtin: true,
    targets: categoriesTargets(STUDY_DISTRACTIONS),
    whitelistOnly: false,
    mode: null,
    durationMinutes: 60,
    reason: null,
  },
  {
    id: 'examen',
    label: SHARED_ES.templates.examen,
    builtin: true,
    targets: emptyTargets(),
    whitelistOnly: true,
    mode: 'exam',
    durationMinutes: 180,
    reason: null,
  },
  {
    id: 'leer',
    label: SHARED_ES.templates.leer,
    builtin: true,
    targets: categoriesTargets(STUDY_DISTRACTIONS),
    whitelistOnly: false,
    mode: null,
    durationMinutes: 30,
    reason: null,
  },
]);

// ---------------------------------------------------------------------------------------
// Operations in flight (main-owned, survive hiding the window)
// ---------------------------------------------------------------------------------------

/** «Bloqueando…» (§4 «Nada aparece como activo hasta que el guardián lo confirma»). */
export interface PendingCreate {
  intentId: IntentId;
  /** Exactly what is (re)sent; «Reintentar» reuses it with the same key. */
  request: CreateBlockRequest;
  status: 'sending' | 'failed';
  startedAt: number;
  attempts: number;
  error: UiError | null;
}

/** One queued extension: nothing reaches the guardian before `commitAt` (5 s undo). */
export interface ExtendEntry {
  id: string;
  blockId: BlockId;
  /** Clicks on the same block inside the window add up (+15 then +30 = +45). */
  addMinutes: number;
  createdAt: number;
  /** Send time; each new click on the same block restarts it. */
  commitAt: number;
  /** «termina a las 18:12»: confirmed `endsAt` + `addMinutes` (display only). */
  projectedEndsAt: IsoUtc;
  /** `waiting` can be undone; `sending` / `failed` already left the undo window. */
  status: 'waiting' | 'sending' | 'failed';
  error: UiError | null;
}

export interface UiOps {
  create: PendingCreate | null;
  /**
   * The last create the guardian confirmed (201). Main clears `create` and inserts the
   * returned block into `state.blocks` in the same publish; the renderer that holds the
   * card with this `intentId` closes it in the same render (`reconcileMainLocal`), so the
   * card never flashes back to its edit state.
   */
  lastCreated: { intentId: IntentId; blockId: BlockId } | null;
  extendQueue: ExtendEntry[];
}

// ---------------------------------------------------------------------------------------
// Snapshot (main-owned)
// ---------------------------------------------------------------------------------------

export interface AppInfo {
  version: string;
  platform: Platform;
  packaged: boolean;
  /** «Actualizar a v1.3.0» in the footer; `null` when current. */
  updateVersion: string | null;
}

/** Present only in harness mode (unpackaged app started with a harness state). */
export interface HarnessInfo {
  stateId: string;
  /** Frozen clock (screenshots); `null` runs on the real clock. */
  frozenNowMs: number | null;
}

export interface UiSnapshot {
  /** Increases on every change; renderers ignore a snapshot whose `rev` is not newer. */
  rev: number;
  link: GuardianLink;
  /**
   * Last good `GET /v1/state` (display time). Kept while the guardian is down: the UI shows
   * it under the protection warning. `null` before the first answer.
   */
  state: GuardianStateResponse | null;
  stateReceivedAt: number | null;
  /** Last `GET /v1/health` (capabilities, problems, versions). */
  health: HealthResponse | null;
  ops: UiOps;
  prefs: UiPrefs;
  templates: BlockTemplate[];
  features: FeatureFlags;
  app: AppInfo;
  harness: HarnessInfo | null;
}

export function initialLink(nowMs: number): GuardianLink {
  return { status: 'connecting', reason: null, since: nowMs, lastOkAt: null, failures: 0 };
}

export function initialSnapshot(
  app: AppInfo,
  nowMs: number,
  prefs: UiPrefs = DEFAULT_PREFS,
  templates: readonly BlockTemplate[] = DEFAULT_TEMPLATES,
  features: FeatureFlags = FEATURES,
): UiSnapshot {
  return {
    rev: 1,
    link: initialLink(nowMs),
    state: null,
    stateReceivedAt: null,
    health: null,
    ops: { create: null, lastCreated: null, extendQueue: [] },
    prefs: { ...prefs },
    templates: templates.map((t) => ({ ...t })),
    features,
    app,
    harness: null,
  };
}

/** The app's «now»: the harness's frozen clock when set, else `fallback`. */
export function snapshotNow(snapshot: UiSnapshot, fallback: number = Date.now()): number {
  return snapshot.harness?.frozenNowMs ?? fallback;
}

// ---------------------------------------------------------------------------------------
// Renderer-local state (fixture-settable)
// ---------------------------------------------------------------------------------------

/** In-place «¿Seguro?» (PROMPT §10): second press within 3 s applies. */
export interface ArmedState {
  /** Stable id of the armed control (`emergency-unlock`, `delete-data`…). */
  id: string;
  at: number;
}

/** The tile whose help replaces a row's help line (hover or focus). */
export interface HelpFocus {
  /** Row id (`templates`, `modes`, `extend`, `footer`…). */
  row: string;
  /** Tile id inside the row (`strict`, `+30`, `quit`…). */
  item: string;
}

export interface ComposerState {
  /** «¿Qué quieres hacer?». The example phrase rotates from the clock, not from state. */
  text: string;
  /** «Nuevo» pill pressed while a block is active: the field shows under the countdown. */
  openWhileActive: boolean;
}

export type CardOrigin = 'phrase' | 'template' | 'form' | 'tray';
export type CardField = 'targets' | 'duration' | 'end' | 'mode' | 'reason';

/** The confirmation card (section 2), replacing the templates row. */
export interface ConfirmCardState {
  /** New per card; «Reintentar» reuses it. */
  intentId: IntentId;
  origin: CardOrigin;
  phrase: string | null;
  templateId: string | null;
  draft: BlockDraft;
  /** `consequence`: the red line after the first Enter (> 4 h, Hardcore, Examen). */
  step: 'edit' | 'consequence';
  /** The confirm button stays disabled `UI_TIMINGS.consequenceLockMs` from here. */
  consequenceAt: number | null;
  /** Chip or field being corrected in place. */
  editing: CardField | null;
}

export interface MainLocalState {
  composer: ComposerState;
  card: ConfirmCardState | null;
  /** «Otro…» on the extend row: an inline minutes field. */
  extendOther: { open: boolean; text: string };
  armed: ArmedState | null;
  help: HelpFocus | null;
}

export interface BloqueosLocalState {
  /** The advanced form (targets, duration or end, mode, reason). */
  form: BlockDraft;
  /** Phrase the form was seeded from («No he entendido…» → Enter). */
  seedPhrase: string | null;
  /** Catalog search box. */
  search: string;
  domainInput: string;
  processInput: string;
  /** Non-null while naming a new template («Guardar como plantilla»). */
  templateName: string | null;
}

export interface EmergenciaLocalState {
  /** Blocks the unlock targets; `null` = every eligible one. */
  blockIds: BlockId[] | null;
  /** The commitment phrase, typed by hand (paste is refused). */
  phrase: string;
  /** Shown after «Desbloquear» succeeds. */
  result: ConfirmEmergencyResponse | null;
}

export interface AjustesLocalState {
  /** Group scrolled into view when opened (`DetailRequest.group`). */
  group: AjustesGroup | null;
  /** New pairing code, shown at 32 px until it expires. */
  pairing: PairingCodeResponse | null;
  /** The BORRAR box of «Borrar todos mis datos». */
  deleteWord: string;
  /** «Copiado» feedback of «Copiar diagnóstico». */
  diagnostics: 'guardian' | 'fallback' | null;
}

export interface DetailLocalState {
  bloqueos: BloqueosLocalState;
  emergencia: EmergenciaLocalState;
  ajustes: AjustesLocalState;
  armed: ArmedState | null;
  help: HelpFocus | null;
}

/** Bloqueos is opened with: an optional seed and a section to scroll to. */
export type DetailRequest =
  | {
      name: 'bloqueos';
      seed: DraftSeed | null;
      focus: 'form' | 'active' | 'templates' | 'schedules' | null;
    }
  | { name: 'emergencia'; blockIds: BlockId[] | null }
  | { name: 'ajustes'; group: AjustesGroup | null };

export function initialMainLocal(): MainLocalState {
  return {
    composer: { text: '', openWhileActive: false },
    card: null,
    extendOther: { open: false, text: '' },
    armed: null,
    help: null,
  };
}

export function initialDetailLocal(prefs: UiPrefs = DEFAULT_PREFS): DetailLocalState {
  return {
    bloqueos: {
      form: draftFromSeed(null, prefs),
      seedPhrase: null,
      search: '',
      domainInput: '',
      processInput: '',
      templateName: null,
    },
    emergencia: { blockIds: null, phrase: '', result: null },
    ajustes: { group: null, pairing: null, deleteWord: '', diagnostics: null },
    armed: null,
    help: null,
  };
}

// ---------------------------------------------------------------------------------------
// Whole state
// ---------------------------------------------------------------------------------------

export interface RenderEnv {
  window: WindowKind;
  platform: Platform;
  layout: WindowLayout;
  /** Detail window only: the view it shows. */
  detail: DetailRequest | null;
  /** Timers (countdown, example rotation, arming) run only while visible. */
  visible: boolean;
}

export interface UiState {
  env: RenderEnv;
  snapshot: UiSnapshot;
  main: MainLocalState;
  detail: DetailLocalState;
}

// ---------------------------------------------------------------------------------------
// Shared timings (one number, one meaning, everywhere)
// ---------------------------------------------------------------------------------------

export const UI_TIMINGS = Object.freeze({
  /** «Deshacer (5 s)»: the extension is sent only after this. */
  extendUndoMs: 5_000,
  /** In-place «¿Seguro?» stays armed this long. */
  armMs: 3_000,
  /** «Sí, bloquear 6 h» is disabled this long after the consequence line appears. */
  consequenceLockMs: 2_000,
  /** «Hecho. +80 puntos» stays this long after a block completes. */
  finishedLineMs: 60_000,
  /** The empty field shows a new example phrase this often. */
  exampleRotateMs: 4_000,
  /** «Si no responde en 3 s». */
  requestTimeoutMs: GUARDIAN_LIMITS.requestTimeoutMs,
  /** `/v1/state` while any window is visible. */
  statePollVisibleMs: GUARDIAN_LIMITS.statePollIntervalMs,
  /** `/v1/state` while hidden (tooltip), besides every event batch and resume. */
  statePollHiddenMs: 60_000,
  /** One quick retry after a failed poll before the link goes `down`. */
  linkRetryMs: 1_000,
  /** The protection warning appears at most this long after detection. */
  warningMaxDelayMs: 5_000,
  /** At most one OS notification per minute (grouped). */
  notifyMinIntervalMs: 60_000,
  /** «Quedan 5 min». */
  fiveMinutesLeftMs: 5 * 60_000,
  /** Refresh this long after `blocks[0].endsAt` so the end shows within about 1 s. */
  blockEndRefreshDelayMs: 300,
  /** Tray click → window shown with the field focused. */
  showBudgetMs: 150,
  /** Wait at most this for the renderer's measured height before showing anyway. */
  showAckTimeoutMs: 50,
  /** Windows: a blur this close to a tray click means the click should hide. */
  trayBlurGraceMs: 250,
});

/** +15 min | +30 min | +1 h (then «Otro…»). */
export const EXTEND_PRESETS = [15, 30, 60] as const;

// ---------------------------------------------------------------------------------------
// Selectors (canonical meaning of the guardian state for the UI, tray and title)
// ---------------------------------------------------------------------------------------

/** Accent of a mode, the same everywhere (bar, selected mode tile, tray icon): PROMPT §10. */
export function modeAccent(mode: BlockMode): 'blue' | 'orange' | 'red' {
  return mode === 'normal' ? 'blue' : mode === 'strict' ? 'orange' : 'red';
}

/** The block that drives the big countdown: `blocks[0]` (the guardian sorts `endsAt` desc). */
export function primaryBlock(state: GuardianStateResponse | null): Block | null {
  return state?.blocks[0] ?? null;
}

/** The other active blocks (28 px rows: at most 2, then «y N más…»). */
export function secondaryBlocks(state: GuardianStateResponse | null): Block[] {
  return state ? state.blocks.slice(1) : [];
}

/** The punishment that dominates the section (latest end). */
export function activePunishment(state: GuardianStateResponse | null): Punishment | null {
  return state?.punishments[0] ?? null;
}

/**
 * «Hecho. +80 puntos»: user and schedule blocks completed less than 1 min ago, their points
 * summed. `null` when there is nothing to show.
 */
export function finishedNotice(
  state: GuardianStateResponse | null,
  nowMs: number,
): { endedAt: IsoUtc; pointsDelta: number; count: number } | null {
  if (!state) return null;
  const recent = state.recent.endedBlocks.filter(
    (b) =>
      b.outcome === 'completed' &&
      (b.kind === 'manual' || b.kind === 'schedule') &&
      nowMs - Date.parse(b.endedAt) < UI_TIMINGS.finishedLineMs,
  );
  if (recent.length === 0) return null;
  const latest = recent.reduce((a, b) => (Date.parse(b.endedAt) > Date.parse(a.endedAt) ? b : a));
  return {
    endedAt: latest.endedAt,
    pointsDelta: recent.reduce((sum, b) => sum + b.pointsDelta, 0),
    count: recent.length,
  };
}

/** After a reboot the primary block's end passed but is still enforced: «Comprobando la hora…». */
export function isBootHold(state: GuardianStateResponse | null, nowMs: number): boolean {
  const hold = state?.clock.bootHoldUntil ?? null;
  const block = primaryBlock(state);
  return (
    hold !== null && block !== null && Date.parse(hold) > nowMs && Date.parse(block.endsAt) <= nowMs
  );
}

/** Which body section 2 («Bloqueo») shows. BLOQUEO renders one component per variant. */
export type BloqueoVariant =
  /** Field + templates (typing, chips and «No he entendido» are sub-states of it). */
  | 'idle'
  /** The confirmation card (also over an active block, after «Nuevo»). */
  | 'confirm'
  /** «Bloqueando…» (card shown, button label only, no spinner). */
  | 'pending'
  /** «El guardián no responde · Reintentar · Reparar» or a rejected create. */
  | 'failed'
  | 'active'
  /** Red bar, no extend row. */
  | 'punishment'
  /** «Bloqueo: terminado» · «Hecho. +80 puntos» for 1 min. */
  | 'finished'
  /** «Comprobando la hora…» instead of 0:00. */
  | 'boot-hold';

export function bloqueoVariant(
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): BloqueoVariant {
  const create = snapshot.ops.create;
  if (create && (main.card === null || main.card.intentId === create.intentId)) {
    return create.status === 'sending' ? 'pending' : 'failed';
  }
  if (main.card) return 'confirm';
  const state = snapshot.state;
  if (state && state.blocks.length > 0) {
    if (isBootHold(state, nowMs)) return 'boot-hold';
    return activePunishment(state) ? 'punishment' : 'active';
  }
  if (main.composer.text === '' && finishedNotice(state, nowMs)) return 'finished';
  return 'idle';
}

/**
 * Local state after a new snapshot: the card whose create the guardian just confirmed
 * closes (and the field empties). The store applies it in the same update as the snapshot.
 */
export function reconcileMainLocal(snapshot: UiSnapshot, main: MainLocalState): MainLocalState {
  const done = snapshot.ops.lastCreated;
  if (main.card && done && done.intentId === main.card.intentId) {
    return {
      ...main,
      composer: { text: '', openWhileActive: false },
      card: null,
      armed: null,
      help: null,
    };
  }
  return main;
}

/** Minutes the extend queue still holds for a block (waiting or in flight). */
export function queuedExtendMinutes(ops: UiOps, blockId: BlockId): number {
  return ops.extendQueue
    .filter((e) => e.blockId === blockId)
    .reduce((sum, e) => sum + e.addMinutes, 0);
}

/**
 * Largest extension the guardian would accept now: the remaining time (queued minutes
 * included) can never exceed 24 h. 0 means the extend tiles are disabled.
 */
export function maxExtendMinutes(block: Block, ops: UiOps, nowMs: number): number {
  if (block.kind === 'punishment') return 0;
  const remaining = Math.max(0, Math.ceil((Date.parse(block.endsAt) - nowMs) / 60_000));
  return Math.max(
    0,
    GUARDIAN_LIMITS.blockMaxMinutes - remaining - queuedExtendMinutes(ops, block.id),
  );
}

// ---------------------------------------------------------------------------------------
// Draft helpers (confirmation card, Bloqueos form, templates, fixtures)
// ---------------------------------------------------------------------------------------

/** End of a draft in ms (display time). */
export function draftEndsAtMs(draft: BlockDraft, nowMs: number): number {
  return draft.end.kind === 'duration'
    ? nowMs + draft.end.minutes * 60_000
    : Date.parse(draft.end.endsAt);
}

/** Minutes the block would last if confirmed now (an «hasta» end is rounded up). */
export function draftMinutes(draft: BlockDraft, nowMs: number): number {
  return draft.end.kind === 'duration'
    ? draft.end.minutes
    : Math.ceil((Date.parse(draft.end.endsAt) - nowMs) / 60_000);
}

/** > 4 h, Hardcore or Examen: the first Enter shows the red consequence line. */
export function draftNeedsConsequence(draft: BlockDraft, nowMs: number): boolean {
  return (
    draft.mode === 'hardcore' ||
    draft.mode === 'exam' ||
    draftMinutes(draft, nowMs) > GUARDIAN_LIMITS.longBlockConfirmMinutes
  );
}

export type DraftProblem = 'no_targets' | 'too_short' | 'too_long';

/** Why a draft cannot be sent yet (the card shows it on its help line), or `null`. */
export function draftProblem(draft: BlockDraft, nowMs: number): DraftProblem | null {
  const t = draft.targets;
  const hasTargets =
    t.serviceIds.length +
      t.categoryIds.length +
      t.appIds.length +
      t.customDomains.length +
      t.customProcesses.length >
    0;
  if (!draft.whitelistOnly && draft.mode !== 'exam' && !hasTargets) return 'no_targets';
  const minutes = draftMinutes(draft, nowMs);
  if (minutes < GUARDIAN_LIMITS.blockMinMinutes) return 'too_short';
  if (minutes > GUARDIAN_LIMITS.blockMaxMinutes) return 'too_long';
  return null;
}

/**
 * The exact request the card sends (main validates it again with `isCreateBlockRequest`).
 * Examen forces the whitelist; acknowledgements follow `draftNeedsConsequence`.
 */
export function draftToCreateRequest(draft: BlockDraft, nowMs: number): CreateBlockRequest {
  const whitelistOnly = draft.mode === 'exam' || draft.whitelistOnly;
  return {
    targets: whitelistOnly ? emptyTargets() : cloneTargets(draft.targets),
    whitelistOnly,
    allow: emptyAllow(),
    mode: draft.mode,
    durationMinutes: draft.end.kind === 'duration' ? draft.end.minutes : null,
    endsAt: draft.end.kind === 'until' ? draft.end.endsAt : null,
    reason: draft.reason.trim(),
    acknowledgeLong: draftMinutes(draft, nowMs) > GUARDIAN_LIMITS.longBlockConfirmMinutes,
    acknowledgeNoEmergency: draft.mode === 'hardcore' || draft.mode === 'exam',
  };
}

/** Switch mode; entering Examen keeps the targets aside, leaving it restores them. */
export function withMode(draft: BlockDraft, mode: BlockMode): BlockDraft {
  if (mode === draft.mode) return draft;
  if (mode === 'exam') {
    if (draft.whitelistOnly) return { ...draft, mode };
    return {
      ...draft,
      mode,
      whitelistOnly: true,
      savedTargets: cloneTargets(draft.targets),
      targets: emptyTargets(),
    };
  }
  if (draft.mode === 'exam' && draft.savedTargets) {
    return {
      ...draft,
      mode,
      whitelistOnly: false,
      targets: draft.savedTargets,
      savedTargets: null,
    };
  }
  return { ...draft, mode };
}

/** The card for a phrase the parser fully understood as a block; `null` otherwise. */
export function draftFromParse(parse: ParseResult, prefs: UiPrefs): BlockDraft | null {
  if (parse.kind !== 'block' || !parse.complete) return null;
  const end = parseEnd(parse);
  if (!end) return null;
  return {
    targets: parseTargets(parse),
    whitelistOnly: false,
    savedTargets: null,
    mode: prefs.defaultMode,
    end,
    reason: prefs.lastReason,
  };
}

/** What Bloqueos opens with when the phrase was not (fully) understood. Nothing is invented. */
export function draftSeedFromParse(phrase: string, parse: ParseResult): DraftSeed {
  const targets = parseTargets(parse);
  const any =
    targets.serviceIds.length + targets.categoryIds.length + targets.customDomains.length > 0;
  return {
    phrase,
    targets: any ? targets : null,
    end: parseEnd(parse),
    mode: null,
    reason: null,
  };
}

/** The Bloqueos form: the seed where given, visible defaults elsewhere (60 min, default mode). */
export function draftFromSeed(seed: DraftSeed | null, prefs: UiPrefs): BlockDraft {
  return {
    targets: seed?.targets ? cloneTargets(seed.targets) : emptyTargets(),
    whitelistOnly: false,
    savedTargets: null,
    mode: seed?.mode ?? prefs.defaultMode,
    end: seed?.end ?? { kind: 'duration', minutes: 60 },
    reason: seed?.reason ?? prefs.lastReason,
  };
}

export function draftFromTemplate(template: BlockTemplate, prefs: UiPrefs): BlockDraft {
  const mode = template.mode ?? prefs.defaultMode;
  const whitelistOnly = template.whitelistOnly || mode === 'exam';
  return {
    targets: whitelistOnly ? emptyTargets() : cloneTargets(template.targets),
    whitelistOnly,
    savedTargets: null,
    mode,
    end: { kind: 'duration', minutes: template.durationMinutes },
    reason: template.reason ?? prefs.lastReason,
  };
}

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
  if (parse.durationMinutes !== undefined)
    return { kind: 'duration', minutes: parse.durationMinutes };
  return null;
}

function cloneTargets(t: TargetSpec): TargetSpec {
  return {
    serviceIds: [...t.serviceIds],
    categoryIds: [...t.categoryIds],
    appIds: [...t.appIds],
    customDomains: [...t.customDomains],
    customProcesses: [...t.customProcesses],
  };
}
