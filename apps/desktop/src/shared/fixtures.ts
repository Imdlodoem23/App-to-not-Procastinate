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
  DailyLimit,
  EmergencyUnlock,
  GuardianSettings,
  IsoUtc,
  LocalDay,
  LimitId,
  PendingSettingChange,
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
  RewardsResponse,
  ScheduleInput,
  SettingsResponse,
} from '@centrate/shared/guardian-api';
import {
  ALL_WEEKDAYS,
  DEFAULT_GUARDIAN_SETTINGS,
  GUARDIAN_CAPABILITIES,
  emptyAllow,
  emptyTargets,
} from '@centrate/shared/guardian-api';
import { parseIntent } from '@centrate/shared/parser';
import type { Locale } from './i18n/locale';
import {
  ACHIEVEMENTS,
  EMERGENCY_RULES,
  REWARD_OFFERS,
  RULES_VERSION,
  addDays,
  emergencyPenalty,
  mascotStage,
  xpForLevel,
} from '@centrate/shared/points';
import { FEATURES, type FeatureFlags } from './features';
import { limitDraftFromParse } from './limits';
import type { HarnessLoad } from './ipc';
import type { AchievementStatus, InstallOutcome, RunningProcess, UpdaterState } from './platform';
import type { OnboardingStep } from './prefs';
import {
  STATS_RANGES,
  daysBetween,
  heatmapLevel,
  isoWeekdayIndex,
  statsPeriod,
  type EventLogEntry,
  type EventLogPage,
  type HeatmapCell,
  type HourStat,
  type StatsBucket,
  type StatsHeatmap,
  type StatsOverview,
  type StatsRange,
  type TopTarget,
} from './stats';
import {
  DEFAULT_PREFS,
  DEFAULT_TEMPLATES,
  bloqueoVariant,
  clonePrefs,
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
  type LimitCardState,
  type DetailName,
  type DetailRequest,
  type ExtendEntry,
  type GuardianLink,
  type MainLocalState,
  type Platform,
  type PlatformSnapshotPatch,
  type SurfaceKind,
  type UiOps,
  type UiPrefs,
  type UiSnapshot,
  type UiState,
  type UiWindow,
  type WindowLayout,
  initialPlatformState,
  isSurfaceKind,
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
  /** A `limit` block of daily limit `lim_fixture…N`. */
  limitN?: number;
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
    ...(spec.limitN === undefined ? {} : { limitId: fixtureId('lim', spec.limitN) as LimitId }),
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
  nuclearActive?: boolean;
  /** Daily limits (exact usage: the state floors it to whole minutes). */
  limits?: DailyLimit[];
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
    nuclearActive: parts.nuclearActive ?? false,
    study: null,
    emergency: parts.emergency ?? null,
    allowances: [],
    rewardsLock: parts.rewardsLock ?? null,
    nextSchedule: parts.nextSchedule === undefined ? nextScheduleInfo(now) : parts.nextSchedule,
    points: parts.points ?? makePoints(),
    pendingSettings: [],
    recent: { endedBlocks: parts.endedBlocks ?? [], endedStudy: null },
    limits: (parts.limits ?? []).map(stateLimit),
  };
}

/** A limit as `/v1/state` shows it: today's usage floored to whole minutes. */
export function stateLimit(limit: DailyLimit): DailyLimit {
  const used = Math.floor(limit.usedTodaySeconds / 60) * 60;
  return {
    ...limit,
    usedTodaySeconds: used,
    remainingTodaySeconds: Math.max(0, limit.dailyMinutes * 60 - used),
  };
}

/** Until the next local midnight of `HARNESS_NOW` (17:00 in Madrid → 00:00): 7 h. */
const TO_MIDNIGHT_MS = 7 * 60 * MIN;

/** The limit block of «Redes sociales» (used up at 16:35, blocked until 00:00). */
export function limitBlock(now: number): Block {
  return makeBlock(
    {
      n: 31,
      categories: ['social'],
      mode: 'strict',
      kind: 'limit',
      leftMs: TO_MIDNIGHT_MS,
      elapsedMs: 25 * MIN,
      limitN: 2,
    },
    now,
  );
}

/**
 * Daily limits with exact usage (`GET /v1/limits`): «YouTube» 12 min 20 s of 30 min every day;
 * «Redes sociales» 1 h on weekdays, used up at 16:35 (its block runs until 00:00); «TikTok»
 * 5 of 45 min with a raise to 1 h waiting until tomorrow.
 */
export function makeLimits(now: number): DailyLimit[] {
  const day = harnessDay(now);
  const created = iso(now - 6 * 24 * 60 * MIN);
  const base = {
    enabled: true,
    reason: '',
    createdAt: created,
    updatedAt: created,
    day,
    appliesToday: true,
    pendingChange: null,
  };
  return [
    {
      ...base,
      id: fixtureId('lim', 1) as LimitId,
      name: 'YouTube',
      targets: { ...emptyTargets(), serviceIds: ['youtube'] },
      dailyMinutes: 30,
      days: [...ALL_WEEKDAYS],
      mode: 'strict',
      usedTodaySeconds: 12 * 60 + 20,
      remainingTodaySeconds: 17 * 60 + 40,
      reachedAt: null,
      activeBlockId: null,
    },
    {
      ...base,
      id: fixtureId('lim', 2) as LimitId,
      name: 'Redes sociales',
      targets: { ...emptyTargets(), categoryIds: ['social'] },
      dailyMinutes: 60,
      days: [1, 2, 3, 4, 5],
      mode: 'strict',
      reason: REASON,
      usedTodaySeconds: 60 * 60,
      remainingTodaySeconds: 0,
      reachedAt: iso(now - 25 * MIN),
      activeBlockId: limitBlock(now).id,
    },
    {
      ...base,
      id: fixtureId('lim', 3) as LimitId,
      name: 'TikTok',
      targets: { ...emptyTargets(), serviceIds: ['tiktok'] },
      dailyMinutes: 45,
      days: [...ALL_WEEKDAYS],
      mode: 'normal',
      usedTodaySeconds: 5 * 60 + 8,
      remainingTodaySeconds: 39 * 60 + 52,
      reachedAt: null,
      activeBlockId: null,
      updatedAt: iso(now - 60 * MIN),
      pendingChange: {
        definition: {
          name: 'TikTok',
          enabled: true,
          targets: { ...emptyTargets(), serviceIds: ['tiktok'] },
          dailyMinutes: 60,
          days: [...ALL_WEEKDAYS],
          mode: 'normal',
          reason: '',
        },
        effectiveAt: iso(now + 23 * 60 * MIN),
      },
    },
  ];
}

/**
 * `GET /v1/rewards` for a balance: offers of the services an active block covers are
 * available when affordable («Te faltan 40 puntos» otherwise); the rest are `not_blocked`.
 */
export function makeRewards(
  balance: number,
  coveredServices: readonly string[],
  lockReason: RewardsLockReason | null = null,
): RewardsResponse {
  return {
    locked: lockReason !== null,
    lockReason,
    balance,
    offers: REWARD_OFFERS.map((o) => {
      const affordable = balance >= o.cost;
      const unavailableReason =
        lockReason !== null
          ? ('locked' as const)
          : !coveredServices.includes(o.serviceId)
            ? ('not_blocked' as const)
            : affordable
              ? null
              : ('insufficient_points' as const);
      return {
        offerId: o.id,
        serviceId: o.serviceId,
        minutes: o.minutes,
        cost: o.cost,
        affordable,
        shortBy: affordable ? 0 : o.cost - balance,
        available: unavailableReason === null,
        unavailableReason,
      };
    }),
    allowances: [],
  };
}

/** The guardian settings of the fixtures (Madrid, 60 min goal, defaults elsewhere). */
export function makeSettings(
  patch: Partial<GuardianSettings> = {},
  pending: PendingSettingChange[] = [],
): SettingsResponse {
  return {
    settings: {
      ...DEFAULT_GUARDIAN_SETTINGS,
      timezone: 'Europe/Madrid',
      punishment: { ...DEFAULT_GUARDIAN_SETTINGS.punishment },
      studyWhitelist: { extraDomains: [], extraProcesses: [] },
      ...patch,
    },
    pending,
  };
}

// ---------------------------------------------------------------------------------------
// Statistics payload builders (deterministic, from the harness clock)
// ---------------------------------------------------------------------------------------

/** Local day of `now` in Madrid (the harness clock is 17:00 there, so the UTC date matches). */
function harnessDay(now: number): LocalDay {
  return new Date(now + 2 * 60 * MIN).toISOString().slice(0, 10);
}

/** A stable pseudo-random 0..1 from an integer (no Math.random: fixtures are deterministic). */
function noise(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Minutes of a past day in the «busy student» fixtures (weekends lighter, some empty days). */
function dayMinutes(day: LocalDay): { focus: number; block: number; attempts: number } {
  const n = Math.round(Date.parse(`${day}T00:00:00Z`) / (24 * 60 * MIN));
  const weekend = isoWeekdayIndex(day) >= 5;
  const r = noise(n);
  if (r < 0.12) return { focus: 0, block: 0, attempts: 0 };
  const block = Math.round(((weekend ? 30 : 60) + r * 90) / 5) * 5;
  const focus = Math.round((r * (weekend ? 40 : 95)) / 5) * 5;
  return { focus, block, attempts: Math.floor(noise(n + 7) * 5) };
}

function emptyTotals(): StatsOverview['totals'] {
  return {
    focusMinutes: 0,
    blockMinutes: 0,
    completedBlocks: 0,
    completedStudySessions: 0,
    attempts: 0,
    pointsEarned: 0,
    pointsLost: 0,
    goalDaysMet: 0,
  };
}

function emptyHours(): HourStat[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, focusMinutes: 0, blockMinutes: 0 }));
}

/** An overview of the period of `range` containing `anchor`; `empty` gives the empty state. */
export function makeStatsOverview(
  range: StatsRange,
  anchor: LocalDay,
  now: number,
  options: { empty?: boolean; goalMinutes?: number } = {},
): StatsOverview {
  const { from, to } = statsPeriod(range, anchor);
  const today = harnessDay(now);
  const goal = options.goalMinutes ?? 60;
  const totals = emptyTotals();
  const hours = emptyHours();
  const lived = (day: LocalDay): boolean => !options.empty && day <= today;
  let buckets: StatsBucket[];
  if (range === 'day') {
    const d = lived(anchor) ? dayMinutes(anchor) : { focus: 0, block: 0, attempts: 0 };
    const nowHour = anchor === today ? new Date(now).getUTCHours() + 2 : 24;
    buckets = Array.from({ length: 24 }, (_, hour) => {
      const active = hour >= 15 && hour <= 20 && hour < nowHour;
      const share = active ? (hour === 17 || hour === 18 ? 0.3 : 0.1) : 0;
      return {
        key: `${anchor}T${String(hour).padStart(2, '0')}`,
        focusMinutes: Math.round(d.focus * share),
        blockMinutes: Math.round(d.block * share),
        attempts: hour === 18 ? d.attempts : 0,
        points: Math.round(d.block * share) + 2 * Math.round(d.focus * share),
      };
    });
  } else {
    buckets = daysBetween(from, to).map((day) => {
      const d = lived(day) ? dayMinutes(day) : { focus: 0, block: 0, attempts: 0 };
      return {
        key: day,
        focusMinutes: d.focus,
        blockMinutes: d.block,
        attempts: d.attempts,
        points: d.block + 2 * d.focus - 10 * d.attempts,
      };
    });
  }
  for (const b of buckets) {
    totals.focusMinutes += b.focusMinutes;
    totals.blockMinutes += b.blockMinutes;
    totals.attempts += b.attempts;
    totals.pointsEarned += b.blockMinutes + 2 * b.focusMinutes;
    totals.pointsLost += 10 * b.attempts;
    if (b.blockMinutes > 0)
      totals.completedBlocks += range === 'day' ? 0 : 1 + (b.blockMinutes > 90 ? 1 : 0);
    if (range !== 'day' && b.key < today && b.focusMinutes + b.blockMinutes >= goal) {
      totals.goalDaysMet += 1;
    }
  }
  if (range === 'day' && totals.blockMinutes > 0) totals.completedBlocks = 2;
  const minutes = totals.focusMinutes + totals.blockMinutes;
  if (minutes > 0) {
    const shares: Record<number, number> = {
      9: 0.05,
      11: 0.05,
      16: 0.2,
      17: 0.3,
      18: 0.25,
      19: 0.15,
    };
    for (const [hour, share] of Object.entries(shares)) {
      const h = hours[Number(hour)];
      if (!h) continue;
      h.focusMinutes = Math.round(totals.focusMinutes * share);
      h.blockMinutes = Math.round(totals.blockMinutes * share);
    }
  }
  const topTargets: TopTarget[] =
    totals.attempts === 0
      ? []
      : [
          {
            kind: 'service',
            id: 'youtube',
            attempts: Math.ceil(totals.attempts * 0.45),
            pointsLost: 0,
          },
          {
            kind: 'service',
            id: 'instagram',
            attempts: Math.ceil(totals.attempts * 0.25),
            pointsLost: 0,
          },
          {
            kind: 'service',
            id: 'tiktok',
            attempts: Math.ceil(totals.attempts * 0.15),
            pointsLost: 0,
          },
          {
            kind: 'domain',
            id: 'reddit.com',
            attempts: Math.max(1, Math.floor(totals.attempts * 0.1)),
            pointsLost: 0,
          },
          { kind: 'app', id: 'steam', attempts: 1, pointsLost: 0 },
        ].map((t) => ({ ...t, pointsLost: t.attempts * 15 }) as TopTarget);
  return {
    range,
    from,
    to,
    buckets,
    totals,
    topTargets,
    hours,
    empty: options.empty ?? false,
  };
}

/** The `weeks` weeks ending with the week of `end`: one cell per day up to today. */
export function makeHeatmap(
  end: LocalDay,
  weeks: number,
  now: number,
  options: { empty?: boolean; goalMinutes?: number } = {},
): StatsHeatmap {
  const goal = options.goalMinutes ?? 60;
  const lastDay = statsPeriod('week', end).to;
  const from = addDays(lastDay, -(weeks * 7 - 1));
  const today = harnessDay(now);
  const cells: HeatmapCell[] = daysBetween(from, lastDay)
    .filter((day) => day <= today)
    .map((day) => {
      const d = options.empty ? { focus: 0, block: 0, attempts: 0 } : dayMinutes(day);
      return {
        day,
        focusMinutes: d.focus,
        blockMinutes: d.block,
        level: heatmapLevel(d.focus + d.block, goal),
      };
    });
  return { from, to: lastDay, goalMinutes: goal, cells };
}

/** A first page of the event log (newest first). */
export function makeEventLog(now: number, options: { empty?: boolean } = {}): EventLogPage {
  if (options.empty) return { entries: [], nextBefore: null, total: 0 };
  const at = (minutesAgo: number): IsoUtc => iso(now - minutesAgo * MIN);
  const rows: Omit<EventLogEntry, 'id'>[] = [
    {
      at: at(18),
      type: 'block_created',
      points: 0,
      target: 'youtube',
      minutes: 60,
      mode: 'strict',
    },
    { at: at(35), type: 'attempt', points: -10, target: 'youtube', minutes: null, mode: 'strict' },
    {
      at: at(62),
      type: 'block_completed',
      points: 60,
      target: 'instagram',
      minutes: 60,
      mode: 'normal',
    },
    {
      at: at(64),
      type: 'reward_redeemed',
      points: -150,
      target: 'youtube',
      minutes: 15,
      mode: null,
    },
    {
      at: at(130),
      type: 'block_extended',
      points: 0,
      target: 'instagram',
      minutes: 30,
      mode: 'normal',
    },
    {
      at: at(190),
      type: 'block_created',
      points: 0,
      target: 'Tardes de estudio',
      minutes: 120,
      mode: 'normal',
    },
    { at: at(24 * 60 - 20), type: 'day_closed', points: 0, target: null, minutes: 60, mode: null },
    {
      at: at(24 * 60 + 30),
      type: 'block_completed',
      points: 120,
      target: 'social',
      minutes: 120,
      mode: 'strict',
    },
    {
      at: at(24 * 60 + 95),
      type: 'attempt',
      points: -20,
      target: 'tiktok',
      minutes: null,
      mode: 'strict',
    },
    {
      at: at(24 * 60 + 97),
      type: 'attempt',
      points: -10,
      target: 'reddit.com',
      minutes: null,
      mode: 'strict',
    },
    {
      at: at(2 * 24 * 60),
      type: 'schedule_updated',
      points: 0,
      target: 'Tardes de estudio',
      minutes: null,
      mode: 'normal',
    },
    {
      at: at(3 * 24 * 60),
      type: 'extension_paired',
      points: 0,
      target: 'chrome',
      minutes: null,
      mode: null,
    },
  ];
  const entries = rows.map((row, i) => ({ id: `ep_fixture0000000001:${420 - i}`, ...row }));
  return { entries, nextBefore: null, total: entries.length };
}

/** Logros: the first block, a 7-day streak and a clean week reached; the rest in progress. */
export function makeAchievements(
  now: number,
  options: { fresh?: boolean } = {},
): AchievementStatus[] {
  const reached: Record<string, { current: number; at: IsoUtc | null }> = {
    'first-block': { current: 48, at: iso(now - 20 * 24 * 60 * MIN) },
    'streak-7': { current: 12, at: iso(now - 9 * 24 * 60 * MIN) },
    'clean-week': { current: 7, at: iso(now - (options.fresh ? 20 : 4 * 24 * 60) * MIN) },
  };
  const progress: Record<string, number> = {
    'first-session': 0,
    'study-10h': 0,
    'sessions-25': 0,
    'streak-30': 12,
    'study-50h': 0,
  };
  return ACHIEVEMENTS.map((a) => {
    const done = reached[a.id];
    return done
      ? {
          id: a.id,
          achieved: true,
          current: done.current,
          threshold: a.threshold,
          achievedAt: done.at,
        }
      : {
          id: a.id,
          achieved: false,
          current: progress[a.id] ?? 0,
          threshold: a.threshold,
          achievedAt: null,
        };
  });
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
  /** `GET /v1/limits` (exact usage); `state.limits` is the same list floored to minutes. */
  limits: DailyLimit[];
  emergencyPreview: EmergencyPreviewResponse;
  pairingCode: PairingCodeResponse;
  extensions: PairedExtension[];
  processNames: string[];
  /** `GET /v1/rewards` (Phase 5). */
  rewards: RewardsResponse;
  behaviour: {
    createBlock: FakeWriteBehaviour;
    extendBlock: FakeWriteBehaviour;
    /** Added to every answer (the «Bloqueando…» label needs a visible moment in flows). */
    latencyMs: number;
  };
}

/**
 * What the app answers from its own data in harness mode (Phase 5): the local event log's
 * statistics and achievements, the process list, the updater and the installer. Main's
 * handlers serve these instead of the real sources while a fixture is loaded, like
 * `FakeGuardianData` stands in for the guardian.
 */
export interface FakeLocalData {
  stats: {
    /** `stats:overview` per range (the anchor of the request is not consulted). */
    overview: Record<StatsRange, StatsOverview>;
    /** `stats:heatmap`: 53 weeks; a request for fewer gets the last `weeks` of them. */
    heatmap: StatsHeatmap;
    /** `stats:events` (first page; later pages are empty). */
    events: EventLogPage;
  };
  achievements: AchievementStatus[];
  processes: RunningProcess[];
  /** What `updater:check` finds (and `download` / `install` move through). */
  updateCheck: UpdaterState;
  /** `onboarding:install-guardian`. */
  installGuardian: InstallOutcome;
}

/** Which window a fixture is about: the main window, a detail view or a Phase 5 surface. */
export type FixtureWindow = 'main' | DetailName | SurfaceKind;

export interface HarnessFixture {
  id: HarnessStateId;
  /** Spanish label for the screenshot index (docs/ui/index.html). */
  label: string;
  /**
   * Window the state is about. Detail fixtures also render the main window beside it;
   * surface fixtures (`mini-timer`, `osd`, `nuclear`) render that window only.
   */
  window: FixtureWindow;
  display: DisplayPresetId;
  nowMs: number;
  snapshot: UiSnapshot;
  main: MainLocalState;
  detail: DetailLocalState;
  /** The detail window's view (`null` for main-window and surface fixtures). */
  detailRequest: DetailRequest | null;
  fake: FakeGuardianData;
  /** Phase 5: answers from the app's own data (statistics, achievements, updater…). */
  local: FakeLocalData;
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

/** Phase 5 states (docs/DESKTOP.md §15): every new window, surface and onboarding step. */
export const PHASE5_STATES = [
  'stats-empty',
  'stats-week',
  'rewards',
  'rewards-short-points',
  'logros',
  'onboarding-1',
  'onboarding-2',
  'onboarding-3',
  'onboarding-4',
  'onboarding-5',
  'mini-timer',
  'osd',
  'nuclear',
  'ajustes-full',
  'schedules',
  'exam-whitelist',
  'update-available',
] as const;

/** Daily limits («YouTube máximo 30 minutos al día»; ARCHITECTURE §5.10). */
export const LIMIT_STATES = [
  'limits',
  'limit-editor',
  'limit-confirm',
  'limit-block',
  'limits-unsupported',
] as const;

export const HARNESS_STATE_IDS = [
  ...PHASE1_REQUIRED_STATES,
  ...EXTRA_STATES,
  ...PHASE5_STATES,
  ...LIMIT_STATES,
] as const;
export type HarnessStateId = (typeof HARNESS_STATE_IDS)[number];

export function isHarnessStateId(value: unknown): value is HarnessStateId {
  return typeof value === 'string' && (HARNESS_STATE_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------
// Shared pieces of the fixtures
// ---------------------------------------------------------------------------------------

const REASON = 'Quiero aprobar mates';
/** The emergency phrase, typed halfway (fixture `emergencia`). */
const EMERGENCY_TYPED_ES = 'Acepto romper mi compromiso';
/** Past the onboarding (Phase 5): only the `onboarding-*` fixtures show it. */
const FIXTURE_PREFS: UiPrefs = {
  ...clonePrefs(DEFAULT_PREFS),
  lastReason: REASON,
  onboarding: { done: true, step: 'first-block' },
};

function prefsWith(patch: Partial<UiPrefs>): UiPrefs {
  return { ...clonePrefs(FIXTURE_PREFS), ...patch };
}
const INTENT = 'intent-fixture-0001';

const PHRASE_OK = 'no veo YouTube en una hora';
const PHRASE_UNKNOWN = 'no veo YouTube mañana tarde';
const PHRASE_LONG = 'bloquea las redes sociales 6 horas';
const PHRASE_HARDCORE = 'sin juegos hora y media';

const APP_INFO: UiSnapshot['app'] = {
  version: '0.1.0',
  platform: 'win32',
  packaged: false,
  updateVersion: null,
  systemLocale: 'es',
};

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

/** The «Límite diario» card of a phrase the parser reads as a daily limit. */
function limitCard(text: string, now: number): LimitCardState {
  const draft = limitDraftFromParse(parse(text, now));
  if (!draft) throw new Error(`fixture phrase not read as a limit: ${text}`);
  return {
    intentId: INTENT,
    phrase: text,
    draft,
    step: 'edit',
    consequenceAt: null,
    sending: false,
    error: null,
  };
}

const PHRASE_LIMIT = 'YouTube máximo 30 minutos al día';

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
  const covered = (state?.blocks ?? []).flatMap((b) => b.targets.serviceIds);
  return {
    reachability: 'ok',
    health: makeHealth(now),
    settings: makeSettings(),
    schedules: makeSchedules(now),
    limits: [],
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
    rewards: makeRewards(balance, covered, state?.rewardsLock ?? null),
    behaviour: { createBlock: 'ok', extendBlock: 'ok', latencyMs: 0 },
  };
}

function localData(now: number, options: { empty?: boolean } = {}): FakeLocalData {
  const today = harnessDay(now);
  const overview = Object.fromEntries(
    STATS_RANGES.map((range) => [range, makeStatsOverview(range, today, now, options)]),
  ) as Record<StatsRange, StatsOverview>;
  return {
    stats: {
      overview,
      heatmap: makeHeatmap(today, 53, now, options),
      events: makeEventLog(now, options),
    },
    achievements: makeAchievements(now),
    processes: [
      { name: 'chrome.exe', appId: null },
      { name: 'Code.exe', appId: null },
      { name: 'Discord.exe', appId: 'discord' },
      { name: 'explorer.exe', appId: null },
      { name: 'Spotify.exe', appId: 'spotify' },
      { name: 'steam.exe', appId: 'steam' },
    ],
    updateCheck: {
      status: 'current',
      version: null,
      percent: null,
      checkedAt: now,
      error: null,
    },
    installGuardian: 'installed',
  };
}

/** The Progreso mascot a snapshot would have: from today's minutes, wilted in the red. */
function progressFor(state: GuardianStateResponse | null): UiSnapshot['progress'] {
  if (!state) return null;
  const { today, balance } = state.points;
  return {
    mascot: mascotStage({
      todayFocusMinutes: today.focusMinutes,
      goalMinutes: today.goalMinutes,
      focusMinutesSinceGiveUp: balance < 0 ? 0 : null,
    }),
    achieved: 3,
    total: ACHIEVEMENTS.length,
    fresh: [],
  };
}

interface Spec {
  label: string;
  window?: FixtureWindow;
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
  local?: (base: FakeLocalData) => FakeLocalData;
  /** Phase 5 snapshot fields over the defaults (updater, OSD, Nuclear…). */
  platform?: PlatformSnapshotPatch;
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
    app: { ...APP_INFO },
    harness: { stateId: id, frozenNowMs: now },
    ...initialPlatformState(),
    progress: progressFor(spec.state),
    updater: {
      status: 'current',
      version: null,
      percent: null,
      checkedAt: now - 30 * MIN,
      error: null,
    },
    activeWindow: {
      status: spec.state && spec.state.blocks.length > 0 ? 'ok' : 'off',
      lastMatch: null,
    },
    ...spec.platform,
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
    local: spec.local ? spec.local(localData(now)) : localData(now),
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
        emergencia: { ...d.emergencia, phrase: EMERGENCY_TYPED_ES },
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

  // -------------------------------------------------------------------------------------
  // Phase 5 (docs/DESKTOP.md §15)
  // -------------------------------------------------------------------------------------

  'stats-empty': (now) =>
    build('stats-empty', now, {
      label: 'Estadísticas sin datos',
      window: 'estadisticas',
      state: makeGuardianState(now, { points: freshPoints() }),
      detailRequest: { name: 'estadisticas', range: null },
      local: (l) => ({ ...localData(now, { empty: true }), achievements: l.achievements }),
    }),

  'stats-week': (now) =>
    build('stats-week', now, {
      label: 'Estadísticas de la semana',
      window: 'estadisticas',
      state: makeGuardianState(now),
      detailRequest: { name: 'estadisticas', range: 'week' },
      detail: detailWith((d) => ({
        ...d,
        estadisticas: { ...d.estadisticas, range: 'week', anchor: LAST_WEEK },
      })),
      local: (l) => ({
        ...l,
        stats: {
          ...l.stats,
          overview: { ...l.stats.overview, week: makeStatsOverview('week', LAST_WEEK, now) },
        },
      }),
    }),

  rewards: (now) =>
    build('rewards', now, {
      label: 'Recompensas',
      window: 'recompensas',
      state: makeGuardianState(now, { blocks: [oneBlock(now)] }),
      detailRequest: { name: 'recompensas' },
    }),

  'rewards-short-points': (now) =>
    build('rewards-short-points', now, {
      label: 'Recompensas: te faltan puntos',
      window: 'recompensas',
      state: makeGuardianState(now, {
        blocks: [oneBlock(now)],
        points: makePoints({ balance: 110 }),
      }),
      detailRequest: { name: 'recompensas' },
      detail: detailWith((d) => ({ ...d, help: { row: 'rewards', item: 'youtube-15' } })),
    }),

  logros: (now) =>
    build('logros', now, {
      label: 'Logros',
      window: 'logros',
      state: makeGuardianState(now),
      detailRequest: { name: 'logros', focus: null },
      detail: detailWith((d) => ({ ...d, help: { row: 'logros', item: 'streak-30' } })),
    }),

  'onboarding-1': (now) => onboarding('onboarding-1', now, 'welcome', 'Onboarding 1: bienvenida'),

  'onboarding-2': (now) =>
    onboarding('onboarding-2', now, 'guardian', 'Onboarding 2: guardián', {
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
      // What section 1 would say; the onboarding hides the sections while it shows.
      warning: 'guardian',
    }),

  'onboarding-3': (now) =>
    onboarding('onboarding-3', now, 'extension', 'Onboarding 3: extensión', {
      state: makeGuardianState(now, {
        points: freshPoints(),
        extensions: [],
        nextSchedule: null,
      }),
      fake: (f) => ({ ...f, extensions: [] }),
      main: mainWith({
        onboarding: {
          pairing: { code: '482913', expiresAt: iso(now + 4 * MIN + 20 * SEC), port: 47600 },
          installing: false,
        },
      }),
    }),

  'onboarding-4': (now) => onboarding('onboarding-4', now, 'camera', 'Onboarding 4: cámara'),

  'onboarding-5': (now) =>
    onboarding('onboarding-5', now, 'first-block', 'Onboarding 5: primer bloqueo', {
      main: mainWith({ composer: { text: ONBOARDING_PHRASE, openWhileActive: false } }),
    }),

  'mini-timer': (now) =>
    build('mini-timer', now, {
      label: 'Mini temporizador',
      window: 'mini-timer',
      state: makeGuardianState(now, { blocks: [oneBlock(now)] }),
      prefs: prefsWith({ miniTimer: { visible: true, position: { x: 1720, y: 24 } } }),
    }),

  osd: (now) => {
    const block = oneBlock(now);
    return build('osd', now, {
      label: 'Aviso grande (OSD)',
      window: 'osd',
      state: makeGuardianState(now, { blocks: [block] }),
      ops: { ...emptyOps(), extendQueue: [extendEntry(block, 15, now)] },
      platform: {
        osd: { id: 1, text: OSD_EXTEND_ES, icon: 'extend', tone: 'orange', shownAt: now - 400 },
      },
    });
  },

  nuclear: (now) => {
    const block = makeBlock(
      {
        n: 11,
        kind: 'punishment',
        categories: ['social', 'video', 'games', 'messaging', 'shopping', 'news'],
        mode: 'strict',
        leftMs: 100 * MIN,
        elapsedMs: 20 * MIN,
        punishmentN: 2,
      },
      now,
    );
    const punishment: Punishment = {
      id: fixtureId('pun', 2),
      blockId: block.id,
      sessionId: fixtureId('stu', 2),
      task: 'mates',
      cause: 'three_strikes',
      level: 'nuclear',
      minutes: 120,
      startsAt: iso(now - 20 * MIN),
      endsAt: block.endsAt,
      status: 'active',
      endedAt: null,
    };
    return build('nuclear', now, {
      label: 'Nuclear',
      window: 'nuclear',
      state: makeGuardianState(now, {
        blocks: [block],
        punishments: [punishment],
        points: makePoints({ balance: 1095 }),
        rewardsLock: 'punishment',
        nuclearActive: true,
      }),
      platform: { nuclear: { overlay: 'shown', displays: 1, lastHeartbeatAt: now - SEC } },
    });
  },

  'ajustes-full': (now) =>
    build('ajustes-full', now, {
      label: 'Ajustes completos (cambios pendientes, actualización)',
      window: 'ajustes',
      state: makeGuardianState(now, { blocks: [oneBlock(now)] }),
      prefs: prefsWith({
        sounds: { ambient: 'rain', volume: 60, autoplay: true },
        reminders: { schedules: true, leadMinutes: 10, eyeBreaks: true },
        shortcuts: {
          'toggle-main': 'CommandOrControl+Alt+C',
          'extend-15': 'CommandOrControl+Alt+E',
          'toggle-mini-timer': null,
        },
      }),
      detailRequest: { name: 'ajustes', group: null },
      fake: (f) => ({
        ...f,
        settings: makeSettings({ dailyGoalMinutes: 60, attemptPenalties: true }, [
          {
            field: 'dailyGoalMinutes',
            value: 45,
            effectiveAt: iso(now + 23 * 60 * MIN + 40 * MIN),
          },
          { field: 'attemptPenalties', value: false, effectiveAt: iso(now + 22 * 60 * MIN) },
        ]),
      }),
      platform: {
        app: { ...APP_INFO, updateVersion: '0.2.0' },
        updater: {
          status: 'available',
          version: '0.2.0',
          percent: null,
          checkedAt: now - 5 * MIN,
          error: null,
        },
        shortcuts: { failed: ['extend-15'] },
      },
    }),

  schedules: (now) =>
    build('schedules', now, {
      label: 'Bloqueos: horarios',
      window: 'bloqueos',
      state: makeGuardianState(now),
      detailRequest: { name: 'bloqueos', seed: null, focus: 'schedules' },
      detail: detailWith((d) => ({
        ...d,
        bloqueos: { ...d.bloqueos, schedule: { id: null, input: newScheduleInput(), error: null } },
      })),
    }),

  'exam-whitelist': (now) =>
    build('exam-whitelist', now, {
      label: 'Bloqueos: modo examen y lista blanca',
      window: 'bloqueos',
      state: makeGuardianState(now),
      detailRequest: { name: 'bloqueos', seed: null, focus: 'exam' },
      detail: detailWith((d) => ({
        ...d,
        bloqueos: { ...d.bloqueos, exam: { domainInput: 'deepl.com', processInput: '' } },
      })),
      fake: (f) => ({
        ...f,
        settings: makeSettings(
          {
            studyWhitelist: {
              extraDomains: ['wikipedia.org', 'khanacademy.org'],
              extraProcesses: ['WINWORD.EXE'],
            },
          },
          [
            {
              field: 'studyWhitelist.extraDomains',
              value: ['wikipedia.org', 'khanacademy.org', 'geogebra.org'],
              effectiveAt: iso(now + 23 * 60 * MIN + 10 * MIN),
            },
          ],
        ),
      }),
    }),

  limits: (now) =>
    build('limits', now, {
      label: 'Bloqueos: límites diarios',
      window: 'bloqueos',
      state: makeGuardianState(now, { blocks: [limitBlock(now)], limits: makeLimits(now) }),
      detailRequest: { name: 'bloqueos', seed: null, focus: 'limits' },
      fake: (f) => ({ ...f, limits: makeLimits(now) }),
    }),

  'limit-editor': (now) =>
    build('limit-editor', now, {
      label: 'Bloqueos: nuevo límite diario',
      window: 'bloqueos',
      state: makeGuardianState(now, { blocks: [limitBlock(now)], limits: makeLimits(now) }),
      detailRequest: { name: 'bloqueos', seed: null, focus: 'limits' },
      fake: (f) => ({ ...f, limits: makeLimits(now) }),
      detail: detailWith((d) => ({
        ...d,
        bloqueos: {
          ...d.bloqueos,
          limit: {
            id: null,
            input: {
              name: '',
              enabled: true,
              targets: { ...emptyTargets(), serviceIds: ['instagram'] },
              dailyMinutes: 45,
              days: [1, 2, 3, 4, 5],
              mode: 'strict',
              reason: '',
              acknowledgeNoEmergency: false,
            },
            minutesText: '45 min',
            error: null,
          },
        },
      })),
    }),

  'limit-confirm': (now) =>
    build('limit-confirm', now, {
      label: 'Confirmación de límite diario',
      state: makeGuardianState(now, { limits: makeLimits(now).slice(1) }),
      main: mainWith({
        composer: { text: PHRASE_LIMIT, openWhileActive: false },
        limitCard: limitCard(PHRASE_LIMIT, now),
      }),
      fake: (f) => ({ ...f, limits: makeLimits(now).slice(1) }),
    }),

  'limit-block': (now) =>
    build('limit-block', now, {
      label: 'Bloqueo por límite diario',
      state: makeGuardianState(now, { blocks: [limitBlock(now)], limits: makeLimits(now) }),
      fake: (f) => ({ ...f, limits: makeLimits(now) }),
    }),

  // An older guardian without `daily_limits`: a limit phrase opens «Límites diarios», which
  // only says why (no list, no «Nuevo límite»).
  'limits-unsupported': (now) => {
    const health = makeHealth(now, {
      capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'daily_limits'),
    });
    return build('limits-unsupported', now, {
      label: 'Bloqueos: límites diarios sin soporte',
      window: 'bloqueos',
      state: makeGuardianState(now),
      health,
      detailRequest: { name: 'bloqueos', seed: null, focus: 'limits' },
      fake: (f) => ({ ...f, health, limits: [] }),
    });
  },

  'update-available': (now) =>
    build('update-available', now, {
      label: 'Actualización lista',
      state: makeGuardianState(now),
      platform: {
        app: { ...APP_INFO, updateVersion: '0.2.0' },
        updater: {
          status: 'ready',
          version: '0.2.0',
          percent: 100,
          checkedAt: now - 20 * MIN,
          error: null,
        },
      },
    }),
};

/** The Monday of the week before `HARNESS_NOW` (a full week of data in `stats-week`). */
const LAST_WEEK = '2026-09-21';

/**
 * What onboarding step 5 leaves typed in the field (PROMPT §10): `firstBlockPhrase` of the
 * onboarding strings, Spanish here and English through `SAMPLE_TEXT_EN`.
 */
const ONBOARDING_PHRASE = 'no veo YouTube en 25 minutos';
const ONBOARDING_PHRASE_EN = 'no YouTube for 25 minutes';

/** The OSD after «Ampliar ▸ +15 min» from the tray (one-block ends at 17:42). */
const OSD_EXTEND_ES = '+15 min · hasta las 17:57';

/** A first-run user: nothing earned yet. */
function freshPoints(): PointsSummary {
  return makePoints({
    balance: 0,
    xp: 0,
    level: 1,
    levelFloorXp: 0,
    nextLevelXp: xpForLevel(2),
    streakDays: 0,
    bestStreakDays: 0,
    today: { day: '2026-09-28', focusMinutes: 0, goalMinutes: 60, goalMet: false },
  });
}

/** «L–V 16:00–19:00 · Redes sociales» being created in Bloqueos (PROMPT §10). */
function newScheduleInput(): ScheduleInput {
  return {
    name: 'Tardes sin redes',
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: '16:00',
    end: '19:00',
    timezone: 'Europe/Madrid',
    targets: { ...emptyTargets(), categoryIds: ['social'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    mode: 'normal',
    reason: '',
    acknowledgeNoEmergency: false,
  };
}

/** The main window centred on one onboarding step of a first run. */
function onboarding(
  id: HarnessStateId,
  now: number,
  step: OnboardingStep,
  label: string,
  spec: Partial<Spec> = {},
): HarnessFixture {
  return build(id, now, {
    label,
    state: makeGuardianState(now, { points: freshPoints(), nextSchedule: null }),
    ...spec,
    prefs: { ...clonePrefs(DEFAULT_PREFS), onboarding: { done: false, step } },
  });
}

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

/**
 * What a Spanish-speaking user typed in the fixtures (reasons, a Study Mode task, schedule
 * names, the emergency phrase half typed), as an English-speaking user would have typed it.
 * The parser reads English phrases in any UI locale, so onboarding step 5 leaves the English
 * first block typed (the same phrase as the onboarding `firstBlockPhrase` in English).
 */
const SAMPLE_TEXT_EN: Readonly<Record<string, string>> = {
  [REASON]: 'I want to pass math',
  mates: 'math',
  'Tardes de estudio': 'Study afternoons',
  'Sábados sin juegos': 'Game-free Saturdays',
  [EMERGENCY_TYPED_ES]: 'I accept breaking my commitment',
  'Tardes sin redes': 'Social-free afternoons',
  'Redes sociales': 'Social media',
  [PHRASE_LIMIT]: 'limit YouTube to 30 min a day',
  [OSD_EXTEND_ES]: '+15 min · until 5:57 PM',
  [ONBOARDING_PHRASE]: ONBOARDING_PHRASE_EN,
  [PHRASE_OK]: 'no YouTube for an hour',
  [PHRASE_UNKNOWN]: 'no YouTube tomorrow afternoon',
  [PHRASE_LONG]: 'block social media for 6 hours',
  [PHRASE_HARDCORE]: 'no games for an hour and a half',
};

/** `value` with every string that is exactly a key of `table` swapped (plain data only). */
function swapStrings<T>(value: T, table: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') {
    return (Object.hasOwn(table, value) ? table[value] : value) as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => swapStrings(item, table)) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = swapStrings(item, table);
    return out as T;
  }
  return value;
}

/**
 * The fixture as seen on an OS in `locale` (`--harness-lang`, `?lang=`): «Idioma» stays
 * «Sistema», so every surface shows that language. In English the user's own sample text is
 * English too (`SAMPLE_TEXT_EN`). Returns a copy.
 */
export function fixtureInLocale(fixture: HarnessFixture, locale: Locale): HarnessFixture {
  const localized = locale === 'en' ? swapStrings(fixture, SAMPLE_TEXT_EN) : fixture;
  const snapshot = localized.snapshot;
  return {
    ...localized,
    snapshot: { ...snapshot, app: { ...snapshot.app, systemLocale: locale } },
  };
}

/** Every fixture, in `HARNESS_STATE_IDS` order. */
export function listHarnessFixtures(nowMs: number = HARNESS_NOW): HarnessFixture[] {
  return HARNESS_STATE_IDS.map((id) => harnessFixture(id, nowMs));
}

/** What main sends a renderer for this fixture (`InitPayload.harness`, `ui:harness`). */
export function harnessLoad(fixture: HarnessFixture): HarnessLoad {
  return { stateId: fixture.id, main: fixture.main, detail: fixture.detail };
}

/** The renderer a fixture is about: `main`, `detail` (a detail view) or a surface. */
export function fixtureWindowKind(fixture: Pick<HarnessFixture, 'window'>): UiWindow {
  if (fixture.window === 'main') return 'main';
  return isSurfaceKind(fixture.window) ? fixture.window : 'detail';
}

/** The surface a fixture is about, or `null` for main and detail fixtures. */
export function fixtureSurface(fixture: Pick<HarnessFixture, 'window'>): SurfaceKind | null {
  return isSurfaceKind(fixture.window) ? fixture.window : null;
}

/**
 * The `UiState` a window renders for a fixture: the main window by default for main
 * fixtures, the detail window for detail fixtures (pass `window` to get the other one).
 */
export function fixtureUiState(fixture: HarnessFixture, window?: UiWindow): UiState {
  const kind: UiWindow = window ?? fixtureWindowKind(fixture);
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
