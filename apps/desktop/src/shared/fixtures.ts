/**
 * Harness fixtures (PROMPT §10 «Arnés de estados», docs/DESKTOP.md §10): one named,
 * deterministic `HarnessFixture` for every Phase 1 UI state.
 *
 * A fixture is a complete `UiState` (main-owned snapshot + renderer-local state for both
 * windows) plus what the fake guardian answers to calls outside `/v1/state` (emergency
 * preview, schedules, pairing…). The same data drives:
 * - the Electron harness (`--harness-state=<id>`, unpackaged only): main seeds its store and
 *   `FakeGuardianClient` from `snapshot` and `fake`, and renderers receive `main`/`detail`
 *   through `app:init` / `ui:harness`;
 * - the browser harness (`vite dev`, `?state=<id>`): an in-memory bridge serves the fixture;
 * - Playwright screenshots (`docs/ui/`) and vitest (every guardian payload here passes the
 *   shared response validators).
 *
 * Clock: `HARNESS_NOW` = Monday 2026-09-28 15:00 UTC = 17:00 in Europe/Madrid (tests and
 * screenshots run with `TZ=Europe/Madrid`). Ids are fixed (`blk_fixture0000000001`…).
 * Dev and test only: main imports it lazily in harness mode; the renderer never imports it in
 * Electron (only the browser harness does, behind `import.meta.env.DEV`).
 */
import type { CategoryId } from '@centrate/shared/catalog';
import { CATALOG_VERSION } from '@centrate/shared/catalog';
import type { Density } from '@centrate/shared/design/tokens';
import type {
  Block,
  BlockKind,
  BlockMode,
  BrowserFamily,
  ClockTrust,
  EmergencyUnlock,
  IsoUtc,
  PointsSummary,
  Punishment,
  RewardsLockReason,
  Schedule,
  TargetSpec,
} from '@centrate/shared/domain';
import type {
  EmergencyPreviewResponse,
  EndedBlockNotice,
  ExtensionStatus,
  GuardianErrorCode,
  GuardianStateResponse,
  HealthResponse,
  NextScheduleInfo,
  PairedExtension,
  PairingCodeResponse,
  SettingsResponse,
} from '@centrate/shared/guardian-api';
import {
  DEFAULT_GUARDIAN_SETTINGS,
  GUARDIAN_CAPABILITIES,
  emptyAllow,
  emptyTargets,
} from '@centrate/shared/guardian-api';
import { parseIntent } from '@centrate/shared/parser';
import { EMERGENCY_RULES, RULES_VERSION, emergencyPenalty } from '@centrate/shared/points';
import { FEATURES, type FeatureFlags } from './features';
import type { HarnessLoad } from './ipc';
import {
  DEFAULT_PREFS,
  DEFAULT_TEMPLATES,
  bloqueoVariant,
  draftFromParse,
  draftFromSeed,
  draftFromTemplate,
  draftSeedFromParse,
  draftToCreateRequest,
  initialDetailLocal,
  initialMainLocal,
  uiError,
  withMode,
  type BloqueoVariant,
  type BlockDraft,
  type ConfirmCardState,
  type DetailLocalState,
  type DetailName,
  type DetailRequest,
  type ExtendEntry,
  type GuardianLink,
  type MainLocalState,
  type Platform,
  type UiOps,
  type UiPrefs,
  type UiSnapshot,
  type UiState,
  type WindowKind,
  type WindowLayout,
} from './ui-state';

// ---------------------------------------------------------------------------------------
// Clock, ids and display presets
// ---------------------------------------------------------------------------------------

/** Monday 2026-09-28 15:00:00 UTC (17:00 in Madrid). */
export const HARNESS_NOW = Date.parse('2026-09-28T15:00:00.000Z');

const MIN = 60_000;
const SEC = 1_000;

/** Deterministic guardian-style id: `blk_fixture0000000001`. */
export function fixtureId<P extends string>(prefix: P, n: number): `${P}_${string}` {
  return `${prefix}_fixture${String(n).padStart(10, '0')}`;
}

function iso(ms: number): IsoUtc {
  return new Date(ms).toISOString();
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DISPLAY_PRESET_IDS = [
  '1366x768@100',
  '1366x768@125',
  '1920x1080@100',
  '1920x1080@150',
] as const;
export type DisplayPresetId = (typeof DISPLAY_PRESET_IDS)[number];

/**
 * A fake display for the screenshot matrix (PROMPT §10: 1366×768 at 100/125 %, 1920×1080 at
 * 100/150 %). Values are DIP, as Electron's `screen` reports them, with a 48 DIP Windows
 * taskbar at the bottom. `frame` stands in for the native frame when the window manager
 * reports none (xvfb); the real one is measured when non-zero.
 */
export interface DisplayPreset {
  id: DisplayPresetId;
  label: string;
  platform: Platform;
  /** `--force-device-scale-factor`. */
  scaleFactor: number;
  bounds: Rect;
  workArea: Rect;
  frame: FrameInsets;
}

const WIN_FRAME: FrameInsets = { top: 32, right: 1, bottom: 1, left: 1 };
const TASKBAR = 48;

function winDisplay(
  id: DisplayPresetId,
  width: number,
  height: number,
  scale: number,
): DisplayPreset {
  const w = Math.round(width / scale);
  const h = Math.round(height / scale);
  return {
    id,
    label: `${width}×${height} al ${Math.round(scale * 100)} %`,
    platform: 'win32',
    scaleFactor: scale,
    bounds: { x: 0, y: 0, width: w, height: h },
    workArea: { x: 0, y: 0, width: w, height: h - TASKBAR },
    frame: { ...WIN_FRAME },
  };
}

export const DISPLAY_PRESETS: Readonly<Record<DisplayPresetId, DisplayPreset>> = Object.freeze({
  '1366x768@100': winDisplay('1366x768@100', 1366, 768, 1),
  '1366x768@125': winDisplay('1366x768@125', 1366, 768, 1.25),
  '1920x1080@100': winDisplay('1920x1080@100', 1920, 1080, 1),
  '1920x1080@150': winDisplay('1920x1080@150', 1920, 1080, 1.5),
});

/** Distance kept from the work area edges (G-Helper: `WorkingArea − 10`). */
export const SCREEN_INSET = 10;

/**
 * The main window's height budget on a preset. MAIN-WINDOW's geometry module computes the
 * same value from the real (or fake) display; a test there compares the two.
 */
export function layoutForDisplay(preset: DisplayPreset): WindowLayout {
  return {
    maxContentHeight:
      preset.workArea.height - 2 * SCREEN_INSET - preset.frame.top - preset.frame.bottom,
    anchor: preset.platform === 'darwin' ? 'top' : 'bottom',
  };
}

// ---------------------------------------------------------------------------------------
// Guardian payload builders (exported for other owners' tests)
// ---------------------------------------------------------------------------------------

export interface BlockSpec {
  n: number;
  services?: string[];
  categories?: CategoryId[];
  whitelistOnly?: boolean;
  mode: BlockMode;
  kind?: BlockKind;
  /** Time left from `now` (ms); negative for a block whose end passed (boot hold). */
  leftMs: number;
  /** Time already run (ms). */
  elapsedMs: number;
  extendedMinutes?: number;
  reason?: string;
  attempts?: number;
  /** Default: normal or strict, and not covered by a pending emergency. */
  emergencyEligible?: boolean;
  punishmentN?: number;
  scheduleN?: number;
}

export function makeBlock(spec: BlockSpec, now: number): Block {
  const whitelistOnly = spec.whitelistOnly ?? spec.mode === 'exam';
  const targets: TargetSpec = whitelistOnly
    ? emptyTargets()
    : {
        ...emptyTargets(),
        serviceIds: [...(spec.services ?? [])],
        categoryIds: [...(spec.categories ?? [])],
      };
  const endsAt = now + spec.leftMs;
  const extended = spec.extendedMinutes ?? 0;
  return {
    id: fixtureId('blk', spec.n),
    kind: spec.kind ?? 'manual',
    mode: spec.mode,
    status: 'active',
    targets,
    whitelistOnly,
    allow: emptyAllow(),
    reason: spec.reason ?? '',
    createdAt: iso(now - spec.elapsedMs),
    startsAt: iso(now - spec.elapsedMs),
    endsAt: iso(endsAt),
    originalEndsAt: iso(endsAt - extended * MIN),
    endedAt: null,
    extendedMinutes: extended,
    scheduleId: spec.scheduleN === undefined ? null : fixtureId('sch', spec.scheduleN),
    punishmentId: spec.punishmentN === undefined ? null : fixtureId('pun', spec.punishmentN),
    attemptsCounted: spec.attempts ?? 0,
    emergencyEligible: spec.emergencyEligible ?? (spec.mode === 'normal' || spec.mode === 'strict'),
    pointsDelta: null,
  };
}

export function makePoints(overrides: Partial<PointsSummary> = {}): PointsSummary {
  return {
    balance: 1240,
    xp: 1300,
    level: 7,
    levelFloorXp: 1260,
    nextLevelXp: 1680,
    streakDays: 5,
    bestStreakDays: 12,
    today: { day: '2026-09-28', focusMinutes: 42, goalMinutes: 60, goalMet: false },
    pendingFocusMinutes: 0,
    ...overrides,
  };
}

export function makeExtensionStatus(
  browser: BrowserFamily,
  now: number,
  overrides: Partial<ExtensionStatus> = {},
): ExtensionStatus {
  return {
    id: fixtureId('ext', 1),
    browser,
    extVersion: '0.1.0',
    connected: true,
    lastSeenAt: iso(now - 20 * SEC),
    incognitoAllowed: true,
    hostPermission: true,
    appliedExtRulesVersion: 5000,
    protecting: true,
    ...overrides,
  };
}

export function makeHealth(now: number, overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    name: 'centrate-guardian',
    version: '0.1.0',
    apiVersion: 1,
    capabilities: [...GUARDIAN_CAPABILITIES],
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    rulesVersion: RULES_VERSION,
    startedAt: iso(now - 9 * 60 * MIN),
    serverNow: iso(now),
    mode: 'normal',
    problems: [],
    ...overrides,
  };
}

export function makeEmergency(
  blockIds: Block['id'][],
  status: 'counting' | 'ready',
  now: number,
  balance: number,
  streakDays: number,
): EmergencyUnlock {
  const countdown = EMERGENCY_RULES.countdownMinutes.normal;
  const readyAt = status === 'counting' ? now + (8 * MIN + 12 * SEC) : now - 30 * SEC;
  return {
    id: fixtureId('emg', 1),
    blockIds: [...blockIds],
    status,
    countdownMinutes: countdown,
    requestedAt: iso(readyAt - countdown * MIN),
    readyAt: iso(readyAt),
    confirmBy:
      status === 'ready' ? iso(readyAt + EMERGENCY_RULES.confirmWindowMinutes * MIN) : null,
    penaltyPreview: emergencyPenalty(balance),
    streakDaysAtRisk: streakDays,
    resolvedAt: null,
    cancelReason: null,
  };
}

const NEXT_SCHEDULE_N = 1;

function nextScheduleInfo(now: number): NextScheduleInfo {
  // «Tardes de estudio», L–V 18:00–20:00 (Madrid): today at 18:00 local.
  return {
    scheduleId: fixtureId('sch', NEXT_SCHEDULE_N),
    name: 'Tardes de estudio',
    startsAt: iso(now + 60 * MIN),
    endsAt: iso(now + 180 * MIN),
  };
}

export function makeSchedules(now: number): Schedule[] {
  return [
    {
      id: fixtureId('sch', NEXT_SCHEDULE_N),
      name: 'Tardes de estudio',
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: '18:00',
      end: '20:00',
      timezone: 'Europe/Madrid',
      targets: { ...emptyTargets(), categoryIds: ['social'] },
      whitelistOnly: false,
      allow: emptyAllow(),
      mode: 'normal',
      reason: '',
      createdAt: iso(now - 10 * 24 * 60 * MIN),
      updatedAt: iso(now - 10 * 24 * 60 * MIN),
      nextOccurrence: { startsAt: iso(now + 60 * MIN), endsAt: iso(now + 180 * MIN) },
      activeBlockId: null,
    },
    {
      id: fixtureId('sch', 2),
      name: 'Sábados sin juegos',
      enabled: false,
      days: [6],
      start: '10:00',
      end: '13:00',
      timezone: 'Europe/Madrid',
      targets: { ...emptyTargets(), categoryIds: ['games'] },
      whitelistOnly: false,
      allow: emptyAllow(),
      mode: 'strict',
      reason: '',
      createdAt: iso(now - 20 * 24 * 60 * MIN),
      updatedAt: iso(now - 3 * 24 * 60 * MIN),
      nextOccurrence: null,
      activeBlockId: null,
    },
  ];
}

export interface StateParts {
  blocks?: Block[];
  punishments?: Punishment[];
  emergency?: EmergencyUnlock | null;
  points?: PointsSummary;
  nextSchedule?: NextScheduleInfo | null;
  endedBlocks?: EndedBlockNotice[];
  extensions?: ExtensionStatus[];
  browsersWithoutExtension?: BrowserFamily[];
  bootHoldUntil?: IsoUtc | null;
  trust?: ClockTrust;
  rewardsLock?: RewardsLockReason | null;
  problems?: string[];
}

/** A `/v1/state` body; blocks and punishments are sorted `endsAt` descending like the guardian's. */
export function makeGuardianState(now: number, parts: StateParts = {}): GuardianStateResponse {
  const blocks = [...(parts.blocks ?? [])].sort(
    (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt),
  );
  const punishments = [...(parts.punishments ?? [])].sort(
    (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt),
  );
  const blocking = blocks.length > 0;
  return {
    stateVersion: 1_790_000_000_000,
    serverNow: iso(now),
    epoch: fixtureId('ep', 1),
    lastEventSeq: 420,
    guardian: { version: '0.1.0', apiVersion: 1, mode: 'normal', problems: parts.problems ?? [] },
    clock: {
      wallOffsetMs: 0,
      trust: parts.trust ?? 'verified',
      lastJump: null,
      lastCalibratedAt: iso(now - 3 * 60 * MIN),
      bootHoldUntil: parts.bootHoldUntil ?? null,
    },
    protection: {
      hosts: {
        ok: true,
        status: 'ok',
        entries: blocking ? 68 : 0,
        lastAppliedAt: blocking ? iso(now - 18 * MIN) : null,
      },
      processWatcher: { ok: true },
      extensions: parts.extensions ?? [makeExtensionStatus('chrome', now)],
      browsersWithoutExtension: parts.browsersWithoutExtension ?? [],
    },
    blocks,
    punishments,
    nuclearActive: false,
    study: null,
    emergency: parts.emergency ?? null,
    allowances: [],
    rewardsLock: parts.rewardsLock ?? null,
    nextSchedule: parts.nextSchedule === undefined ? nextScheduleInfo(now) : parts.nextSchedule,
    points: parts.points ?? makePoints(),
    pendingSettings: [],
    recent: { endedBlocks: parts.endedBlocks ?? [], endedStudy: null },
  };
}

// ---------------------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------------------

/** Scripted answer of a fake guardian write (flows in e2e). */
export type FakeWriteBehaviour =
  | 'ok'
  | 'timeout'
  | 'unreachable'
  | { error: GuardianErrorCode; details?: Record<string, unknown> };

/** What `FakeGuardianClient` (MAIN-GUARDIAN) serves besides `snapshot.state`. */
export interface FakeGuardianData {
  /** `unreachable`: connection refused; `timeout`: never answers; `not_installed`: no client.json. */
  reachability: 'ok' | 'unreachable' | 'timeout' | 'not_installed';
  health: HealthResponse;
  settings: SettingsResponse;
  schedules: Schedule[];
  emergencyPreview: EmergencyPreviewResponse;
  pairingCode: PairingCodeResponse;
  extensions: PairedExtension[];
  processNames: string[];
  behaviour: {
    createBlock: FakeWriteBehaviour;
    extendBlock: FakeWriteBehaviour;
    /** Added to every answer (the «Bloqueando…» label needs a visible moment in flows). */
    latencyMs: number;
  };
}

export interface HarnessFixture {
  id: HarnessStateId;
  /** Spanish label for the screenshot index (docs/ui/index.html). */
  label: string;
  /** Window the state is about. Detail fixtures also render the main window beside it. */
  window: 'main' | DetailName;
  display: DisplayPresetId;
  nowMs: number;
  snapshot: UiSnapshot;
  main: MainLocalState;
  detail: DetailLocalState;
  /** The detail window's view (`null` for main-window fixtures). */
  detailRequest: DetailRequest | null;
  fake: FakeGuardianData;
  /** Self-checks (vitest) and e2e assertions. */
  expect: {
    /** `bloqueoVariant` of the main window. */
    variant: BloqueoVariant;
    /** Section 1: which warning shows (`null`: none). */
    warning: 'guardian' | 'extension' | null;
    /** Density the main window must pick on `display` (checked by e2e). */
    density: Density;
  };
}

/** The states PROMPT §10 requires in Phase 1 (a vitest checks the registry covers them). */
export const PHASE1_REQUIRED_STATES = [
  'idle',
  'typing',
  'not-understood',
  'confirm-normal',
  'confirm-over-4h',
  'confirm-hardcore',
  'confirm-exam',
  'pending',
  'guardian-timeout',
  'one-block',
  'three-blocks',
  'extend-undo',
  'finished',
  'emergency-waiting',
  'emergency-ready',
  'punishment',
  'negative-points',
  'protection-broken',
  'extension-missing',
  'compact-density',
  'bloqueos',
  'emergencia',
  'ajustes',
] as const;

/** Extra states worth a screenshot (edge cases the required list implies). */
export const EXTRA_STATES = [
  'hardcore-block',
  'many-blocks',
  'boot-hold',
  'not-installed',
  'bloqueos-prefilled',
  'ajustes-pairing',
  'ajustes-delete',
] as const;

export const HARNESS_STATE_IDS = [...PHASE1_REQUIRED_STATES, ...EXTRA_STATES] as const;
export type HarnessStateId = (typeof HARNESS_STATE_IDS)[number];

export function isHarnessStateId(value: unknown): value is HarnessStateId {
  return typeof value === 'string' && (HARNESS_STATE_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------
// Shared pieces of the fixtures
// ---------------------------------------------------------------------------------------

const REASON = 'Quiero aprobar mates';
const FIXTURE_PREFS: UiPrefs = { ...DEFAULT_PREFS, lastReason: REASON };
const INTENT = 'intent-fixture-0001';

const PHRASE_OK = 'no veo YouTube en una hora';
const PHRASE_UNKNOWN = 'no veo YouTube mañana tarde';
const PHRASE_LONG = 'bloquea las redes sociales 6 horas';
const PHRASE_HARDCORE = 'sin juegos hora y media';

const LINK_OK = (now: number): GuardianLink => ({
  status: 'ok',
  reason: null,
  since: now - 60 * MIN,
  lastOkAt: now - SEC,
  failures: 0,
});

/** «YouTube, Instagram · Estricto», ends 17:42:10 (countdown 42:10, «quedan 43 min»). */
const oneBlock = (now: number): Block =>
  makeBlock(
    {
      n: 1,
      services: ['youtube', 'instagram'],
      mode: 'strict',
      leftMs: 42 * MIN + 10 * SEC,
      elapsedMs: 17 * MIN + 50 * SEC,
      reason: REASON,
    },
    now,
  );

/** A normal YouTube block (emergency fixtures: 10 min countdown). */
const normalBlock = (now: number, emergencyEligible = true): Block =>
  makeBlock(
    {
      n: 21,
      services: ['youtube'],
      mode: 'normal',
      leftMs: 42 * MIN + 10 * SEC,
      elapsedMs: 17 * MIN + 50 * SEC,
      reason: REASON,
      emergencyEligible,
    },
    now,
  );

const threeBlocks = (now: number): Block[] => [
  makeBlock(
    {
      n: 2,
      categories: ['social'],
      mode: 'strict',
      leftMs: 2 * 60 * MIN + 10 * MIN + 5 * SEC,
      elapsedMs: 50 * MIN,
      reason: REASON,
    },
    now,
  ),
  oneBlock(now),
  makeBlock(
    { n: 3, categories: ['games'], mode: 'hardcore', leftMs: 25 * MIN, elapsedMs: 35 * MIN },
    now,
  ),
];

function parse(text: string, now: number) {
  return parseIntent(text, { now: new Date(now) });
}

function phraseDraft(text: string, now: number): BlockDraft {
  const draft = draftFromParse(parse(text, now), FIXTURE_PREFS);
  if (!draft) throw new Error(`fixture phrase not understood: ${text}`);
  return draft;
}

function card(
  now: number,
  draft: BlockDraft,
  options: { phrase?: string; templateId?: string; consequence?: boolean } = {},
): ConfirmCardState {
  return {
    intentId: INTENT,
    origin: options.templateId ? 'template' : 'phrase',
    phrase: options.phrase ?? null,
    templateId: options.templateId ?? null,
    draft,
    step: options.consequence ? 'consequence' : 'edit',
    consequenceAt: options.consequence ? now - 600 : null,
    editing: null,
  };
}

function mainWith(patch: Partial<MainLocalState>): MainLocalState {
  return { ...initialMainLocal(), ...patch };
}

function emptyOps(): UiOps {
  return { create: null, lastCreated: null, extendQueue: [] };
}

function fakeData(now: number, state: GuardianStateResponse | null): FakeGuardianData {
  const balance = state?.points.balance ?? 1240;
  const streak = state?.points.streakDays ?? 5;
  const eligible = (state?.blocks ?? []).filter((b) => b.emergencyEligible);
  const excluded = (state?.blocks ?? []).filter(
    (b) => (b.mode === 'hardcore' || b.mode === 'exam') && b.kind !== 'punishment',
  );
  const inProgress = state?.emergency != null;
  return {
    reachability: 'ok',
    health: makeHealth(now),
    settings: {
      settings: {
        ...DEFAULT_GUARDIAN_SETTINGS,
        timezone: 'Europe/Madrid',
        punishment: { ...DEFAULT_GUARDIAN_SETTINGS.punishment },
        studyWhitelist: { extraDomains: [], extraProcesses: [] },
      },
      pending: [],
    },
    schedules: makeSchedules(now),
    emergencyPreview: {
      eligible: !inProgress && eligible.length > 0,
      reason: inProgress
        ? 'emergency_in_progress'
        : eligible.length > 0
          ? null
          : (state?.blocks.length ?? 0) > 0
            ? 'hardcore'
            : 'no_active_blocks',
      blockIds: inProgress ? [] : eligible.map((b) => b.id),
      excludedBlockIds: excluded.map((b) => b.id),
      countdownMinutes: eligible.length > 0 ? EMERGENCY_RULES.countdownMinutes.normal : null,
      penaltyPoints: emergencyPenalty(balance),
      balance,
      allowanceValue: 0,
      streakDays: streak,
      phrases: { ...EMERGENCY_RULES.phrases },
    },
    pairingCode: { code: '482913', expiresAt: iso(now + 5 * MIN), port: 47600 },
    extensions: [
      {
        id: fixtureId('ext', 1),
        browser: 'chrome',
        extVersion: '0.1.0',
        pairedAt: iso(now - 6 * 24 * 60 * MIN),
        lastSeenAt: iso(now - 20 * SEC),
        boundOrigin: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah',
      },
    ],
    processNames: [
      'chrome.exe',
      'Code.exe',
      'Discord.exe',
      'explorer.exe',
      'Spotify.exe',
      'steam.exe',
    ],
    behaviour: { createBlock: 'ok', extendBlock: 'ok', latencyMs: 0 },
  };
}

interface Spec {
  label: string;
  window?: 'main' | DetailName;
  display?: DisplayPresetId;
  state: GuardianStateResponse | null;
  link?: GuardianLink;
  health?: HealthResponse | null;
  ops?: UiOps;
  prefs?: UiPrefs;
  features?: FeatureFlags;
  main?: MainLocalState;
  detail?: DetailLocalState;
  detailRequest?: DetailRequest | null;
  fake?: (base: FakeGuardianData) => FakeGuardianData;
  warning?: 'guardian' | 'extension' | null;
  density?: Density;
}

function build(id: HarnessStateId, now: number, spec: Spec): HarnessFixture {
  const prefs = spec.prefs ?? FIXTURE_PREFS;
  const snapshot: UiSnapshot = {
    rev: 100,
    link: spec.link ?? LINK_OK(now),
    state: spec.state,
    stateReceivedAt: spec.state ? now - SEC : null,
    health: spec.health === undefined ? makeHealth(now) : spec.health,
    ops: spec.ops ?? emptyOps(),
    prefs,
    templates: DEFAULT_TEMPLATES.map((t) => ({ ...t })),
    features: spec.features ?? FEATURES,
    app: { version: '0.1.0', platform: 'win32', packaged: false, updateVersion: null },
    harness: { stateId: id, frozenNowMs: now },
  };
  const main = spec.main ?? initialMainLocal();
  const baseFake = fakeData(now, spec.state);
  return {
    id,
    label: spec.label,
    window: spec.window ?? 'main',
    display: spec.display ?? '1920x1080@100',
    nowMs: now,
    snapshot,
    main,
    detail: spec.detail ?? initialDetailLocal(prefs),
    detailRequest: spec.detailRequest ?? null,
    fake: spec.fake ? spec.fake(baseFake) : baseFake,
    expect: {
      variant: bloqueoVariant(snapshot, main, now),
      warning: spec.warning ?? null,
      density: spec.density ?? 'regular',
    },
  };
}

function detailWith(patch: (d: DetailLocalState) => DetailLocalState): DetailLocalState {
  return patch(initialDetailLocal(FIXTURE_PREFS));
}

// ---------------------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------------------

type Builder = (now: number) => HarnessFixture;

const BUILDERS: Readonly<Record<HarnessStateId, Builder>> = {
  idle: (now) => build('idle', now, { label: 'Reposo', state: makeGuardianState(now) }),

  typing: (now) =>
    build('typing', now, {
      label: 'Escribiendo',
      state: makeGuardianState(now),
      main: mainWith({ composer: { text: PHRASE_OK, openWhileActive: false } }),
    }),

  'not-understood': (now) =>
    build('not-understood', now, {
      label: 'Frase no entendida',
      state: makeGuardianState(now),
      main: mainWith({ composer: { text: PHRASE_UNKNOWN, openWhileActive: false } }),
    }),

  'confirm-normal': (now) =>
    build('confirm-normal', now, {
      label: 'Confirmación',
      state: makeGuardianState(now),
      main: mainWith({
        composer: { text: PHRASE_OK, openWhileActive: false },
        card: card(now, phraseDraft(PHRASE_OK, now), { phrase: PHRASE_OK }),
      }),
    }),

  'confirm-over-4h': (now) =>
    build('confirm-over-4h', now, {
      label: 'Confirmación de más de 4 h',
      state: makeGuardianState(now),
      main: mainWith({
        composer: { text: PHRASE_LONG, openWhileActive: false },
        card: card(now, phraseDraft(PHRASE_LONG, now), { phrase: PHRASE_LONG, consequence: true }),
      }),
    }),

  'confirm-hardcore': (now) =>
    build('confirm-hardcore', now, {
      label: 'Confirmación Hardcore',
      state: makeGuardianState(now),
      main: mainWith({
        composer: { text: PHRASE_HARDCORE, openWhileActive: false },
        card: card(now, withMode(phraseDraft(PHRASE_HARDCORE, now), 'hardcore'), {
          phrase: PHRASE_HARDCORE,
          consequence: true,
        }),
      }),
    }),

  'confirm-exam': (now) => {
    const examen = DEFAULT_TEMPLATES.find((t) => t.id === 'examen');
    if (!examen) throw new Error('missing built-in template «examen»');
    return build('confirm-exam', now, {
      label: 'Confirmación Examen',
      state: makeGuardianState(now),
      main: mainWith({
        card: card(now, draftFromTemplate(examen, FIXTURE_PREFS), {
          templateId: 'examen',
          consequence: true,
        }),
      }),
    });
  },

  pending: (now) => {
    const c = card(now, phraseDraft(PHRASE_OK, now), { phrase: PHRASE_OK });
    return build('pending', now, {
      label: 'Bloqueando…',
      state: makeGuardianState(now),
      main: mainWith({ composer: { text: PHRASE_OK, openWhileActive: false }, card: c }),
      ops: {
        ...emptyOps(),
        create: {
          intentId: c.intentId,
          request: draftToCreateRequest(c.draft, now),
          status: 'sending',
          startedAt: now - 800,
          attempts: 1,
          error: null,
        },
      },
      fake: (f) => ({ ...f, behaviour: { ...f.behaviour, latencyMs: 2_000 } }),
    });
  },

  'guardian-timeout': (now) => {
    const c = card(now, phraseDraft(PHRASE_OK, now), { phrase: PHRASE_OK });
    return build('guardian-timeout', now, {
      label: 'El guardián no responde',
      state: makeGuardianState(now),
      main: mainWith({ composer: { text: PHRASE_OK, openWhileActive: false }, card: c }),
      ops: {
        ...emptyOps(),
        create: {
          intentId: c.intentId,
          request: draftToCreateRequest(c.draft, now),
          status: 'failed',
          startedAt: now - 3_200,
          attempts: 1,
          error: uiError('timeout'),
        },
      },
      fake: (f) => ({ ...f, behaviour: { ...f.behaviour, createBlock: 'timeout' } }),
    });
  },

  'one-block': (now) =>
    build('one-block', now, {
      label: 'Un bloqueo',
      state: makeGuardianState(now, { blocks: [oneBlock(now)] }),
    }),

  'three-blocks': (now) =>
    build('three-blocks', now, {
      label: 'Tres bloqueos',
      state: makeGuardianState(now, { blocks: threeBlocks(now) }),
    }),

  'extend-undo': (now) => {
    const block = oneBlock(now);
    return build('extend-undo', now, {
      label: 'Ampliar con deshacer',
      state: makeGuardianState(now, { blocks: [block] }),
      ops: { ...emptyOps(), extendQueue: [extendEntry(block, 30, now)] },
    });
  },

  finished: (now) =>
    build('finished', now, {
      label: 'Terminado',
      state: makeGuardianState(now, {
        points: makePoints({ balance: 1320 }),
        endedBlocks: [
          {
            id: fixtureId('blk', 4),
            kind: 'manual',
            mode: 'normal',
            outcome: 'completed',
            endedAt: iso(now - 20 * SEC),
            pointsDelta: 80,
          },
        ],
      }),
    }),

  'emergency-waiting': (now) => {
    const block = normalBlock(now, false);
    return build('emergency-waiting', now, {
      label: 'Emergencia: esperando',
      window: 'emergencia',
      state: makeGuardianState(now, {
        blocks: [block],
        emergency: makeEmergency([block.id], 'counting', now, 1240, 5),
        rewardsLock: 'emergency',
      }),
      detailRequest: { name: 'emergencia', blockIds: null },
    });
  },

  'emergency-ready': (now) => {
    const block = normalBlock(now, false);
    return build('emergency-ready', now, {
      label: 'Emergencia: lista para desbloquear',
      window: 'emergencia',
      state: makeGuardianState(now, {
        blocks: [block],
        emergency: makeEmergency([block.id], 'ready', now, 1240, 5),
        rewardsLock: 'emergency',
      }),
      detailRequest: { name: 'emergencia', blockIds: null },
      detail: detailWith((d) => ({ ...d, armed: { id: 'emergency-unlock', at: now - 400 } })),
    });
  },

  punishment: (now) => {
    const block = makeBlock(
      {
        n: 5,
        kind: 'punishment',
        categories: ['social', 'video', 'games', 'messaging', 'shopping', 'news'],
        mode: 'strict',
        leftMs: 38 * MIN,
        elapsedMs: 22 * MIN,
        punishmentN: 1,
      },
      now,
    );
    const punishment: Punishment = {
      id: fixtureId('pun', 1),
      blockId: block.id,
      sessionId: fixtureId('stu', 1),
      task: 'mates',
      cause: 'three_strikes',
      level: 'distractions',
      minutes: 60,
      startsAt: iso(now - 22 * MIN),
      endsAt: block.endsAt,
      status: 'active',
      endedAt: null,
    };
    return build('punishment', now, {
      label: 'Castigo',
      state: makeGuardianState(now, {
        blocks: [block],
        punishments: [punishment],
        points: makePoints({ balance: 1095 }),
        rewardsLock: 'punishment',
      }),
    });
  },

  'negative-points': (now) =>
    build('negative-points', now, {
      label: 'Puntos en negativo',
      state: makeGuardianState(now, {
        points: makePoints({
          balance: -340,
          xp: 250,
          level: 3,
          levelFloorXp: 180,
          nextLevelXp: 360,
          streakDays: 0,
          bestStreakDays: 4,
          today: { day: '2026-09-28', focusMinutes: 0, goalMinutes: 60, goalMet: false },
        }),
      }),
    }),

  'protection-broken': (now) =>
    build('protection-broken', now, {
      label: 'Protección rota (guardián detenido)',
      state: makeGuardianState(now - 12 * SEC),
      link: {
        status: 'down',
        reason: 'unreachable',
        since: now - 8 * SEC,
        lastOkAt: now - 12 * SEC,
        failures: 3,
      },
      fake: (f) => ({ ...f, reachability: 'unreachable' }),
      warning: 'guardian',
    }),

  'extension-missing': (now) =>
    build('extension-missing', now, {
      label: 'Falta la extensión',
      state: makeGuardianState(now, {
        blocks: [oneBlock(now)],
        extensions: [],
        browsersWithoutExtension: ['chrome'],
      }),
      fake: (f) => ({ ...f, extensions: [] }),
      warning: 'extension',
    }),

  'compact-density': (now) => {
    const blocks = threeBlocks(now);
    const primary = blocks[0];
    if (!primary) throw new Error('threeBlocks() is empty');
    return build('compact-density', now, {
      label: 'Densidad compacta (1366×768 al 125 %)',
      display: '1366x768@125',
      state: makeGuardianState(now, {
        blocks,
        extensions: [],
        browsersWithoutExtension: ['chrome'],
      }),
      ops: { ...emptyOps(), extendQueue: [extendEntry(primary, 30, now)] },
      fake: (f) => ({ ...f, extensions: [] }),
      warning: 'extension',
      density: 'compact',
    });
  },

  bloqueos: (now) =>
    build('bloqueos', now, {
      label: 'Ventana Bloqueos',
      window: 'bloqueos',
      state: makeGuardianState(now, { blocks: [oneBlock(now)] }),
      detailRequest: { name: 'bloqueos', seed: null, focus: null },
    }),

  emergencia: (now) =>
    build('emergencia', now, {
      label: 'Ventana Emergencia',
      window: 'emergencia',
      state: makeGuardianState(now, { blocks: [normalBlock(now)] }),
      detailRequest: { name: 'emergencia', blockIds: null },
      detail: detailWith((d) => ({
        ...d,
        emergencia: { ...d.emergencia, phrase: 'Acepto romper mi compromiso' },
      })),
    }),

  ajustes: (now) =>
    build('ajustes', now, {
      label: 'Ventana Ajustes',
      window: 'ajustes',
      state: makeGuardianState(now),
      detailRequest: { name: 'ajustes', group: null },
    }),

  'hardcore-block': (now) =>
    build('hardcore-block', now, {
      label: 'Bloqueo Hardcore',
      state: makeGuardianState(now, {
        blocks: [
          makeBlock(
            {
              n: 6,
              services: ['tiktok', 'instagram', 'youtube'],
              mode: 'hardcore',
              leftMs: 95 * MIN + 30 * SEC,
              elapsedMs: 25 * MIN,
              reason: REASON,
            },
            now,
          ),
        ],
      }),
    }),

  'many-blocks': (now) =>
    build('many-blocks', now, {
      label: 'Seis bloqueos («y 3 más…»)',
      state: makeGuardianState(now, {
        blocks: [
          ...threeBlocks(now),
          makeBlock(
            { n: 7, services: ['netflix'], mode: 'normal', leftMs: 20 * MIN, elapsedMs: 10 * MIN },
            now,
          ),
          makeBlock(
            { n: 8, services: ['twitch'], mode: 'normal', leftMs: 15 * MIN, elapsedMs: 15 * MIN },
            now,
          ),
          makeBlock(
            { n: 9, services: ['discord'], mode: 'strict', leftMs: 9 * MIN, elapsedMs: 21 * MIN },
            now,
          ),
        ],
      }),
    }),

  'boot-hold': (now) =>
    build('boot-hold', now, {
      label: 'Comprobando la hora',
      state: makeGuardianState(now, {
        blocks: [
          makeBlock(
            {
              n: 10,
              services: ['youtube'],
              mode: 'normal',
              leftMs: -20 * SEC,
              elapsedMs: 60 * MIN,
            },
            now,
          ),
        ],
        bootHoldUntil: iso(now + 70 * SEC),
        trust: 'unverified',
      }),
    }),

  'not-installed': (now) =>
    build('not-installed', now, {
      label: 'Guardián no instalado',
      state: null,
      health: null,
      link: {
        status: 'down',
        reason: 'not_installed',
        since: now - 30 * SEC,
        lastOkAt: null,
        failures: 4,
      },
      fake: (f) => ({ ...f, reachability: 'not_installed' }),
      warning: 'guardian',
    }),

  'bloqueos-prefilled': (now) => {
    const seed = draftSeedFromParse(PHRASE_UNKNOWN, parse(PHRASE_UNKNOWN, now));
    return build('bloqueos-prefilled', now, {
      label: 'Bloqueos con lo que se entendió',
      window: 'bloqueos',
      state: makeGuardianState(now),
      main: mainWith({ composer: { text: PHRASE_UNKNOWN, openWhileActive: false } }),
      detailRequest: { name: 'bloqueos', seed, focus: 'form' },
      detail: detailWith((d) => ({
        ...d,
        bloqueos: {
          ...d.bloqueos,
          form: draftFromSeed(seed, FIXTURE_PREFS),
          seedPhrase: PHRASE_UNKNOWN,
        },
      })),
    });
  },

  'ajustes-pairing': (now) =>
    build('ajustes-pairing', now, {
      label: 'Ajustes: código de emparejamiento',
      window: 'ajustes',
      state: makeGuardianState(now),
      detailRequest: { name: 'ajustes', group: 'sistema' },
      detail: detailWith((d) => ({
        ...d,
        ajustes: {
          ...d.ajustes,
          group: 'sistema',
          pairing: { code: '482913', expiresAt: iso(now + 4 * MIN + 20 * SEC), port: 47600 },
        },
      })),
    }),

  'ajustes-delete': (now) =>
    build('ajustes-delete', now, {
      label: 'Ajustes: borrar todos mis datos',
      window: 'ajustes',
      state: makeGuardianState(now),
      detailRequest: { name: 'ajustes', group: 'datos' },
      detail: detailWith((d) => ({
        ...d,
        ajustes: { ...d.ajustes, group: 'datos', deleteWord: 'BORRAR' },
      })),
    }),
};

function extendEntry(block: Block, minutes: number, now: number): ExtendEntry {
  return {
    id: 'extend-fixture-0001',
    blockId: block.id,
    addMinutes: minutes,
    createdAt: now - 1_200,
    commitAt: now - 1_200 + 5_000,
    projectedEndsAt: iso(Date.parse(block.endsAt) + minutes * MIN),
    status: 'waiting',
    error: null,
  };
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

/** One fixture, built fresh (callers may mutate it). */
export function harnessFixture(id: HarnessStateId, nowMs: number = HARNESS_NOW): HarnessFixture {
  return BUILDERS[id](nowMs);
}

/** Every fixture, in `HARNESS_STATE_IDS` order. */
export function listHarnessFixtures(nowMs: number = HARNESS_NOW): HarnessFixture[] {
  return HARNESS_STATE_IDS.map((id) => harnessFixture(id, nowMs));
}

/** What main sends a renderer for this fixture (`InitPayload.harness`, `ui:harness`). */
export function harnessLoad(fixture: HarnessFixture): HarnessLoad {
  return { stateId: fixture.id, main: fixture.main, detail: fixture.detail };
}

/**
 * The `UiState` a window renders for a fixture: the main window by default for main
 * fixtures, the detail window for detail fixtures (pass `window` to get the other one).
 */
export function fixtureUiState(fixture: HarnessFixture, window?: WindowKind): UiState {
  const kind: WindowKind = window ?? (fixture.window === 'main' ? 'main' : 'detail');
  const preset = DISPLAY_PRESETS[fixture.display];
  return {
    env: {
      window: kind,
      platform: preset.platform,
      layout: layoutForDisplay(preset),
      detail: kind === 'detail' ? fixture.detailRequest : null,
      visible: true,
    },
    snapshot: fixture.snapshot,
    main: fixture.main,
    detail: fixture.detail,
  };
}
