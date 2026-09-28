/**
 * MockGuardian: an in-memory guardian for development and tests (never in a packaged app).
 *
 * - Dev: `CENTRATE_MOCK_GUARDIAN=1 npm run dev -w apps/desktop` makes the app fully usable
 *   without the Go guardian: blocks with their countdown, extensions, points on completion,
 *   the emergency flow (with a **shortened countdown**: 10 s / 30 s instead of minutes),
 *   settings, pairing codes and the event log (long poll) that drives notifications.
 * - Harness and e2e: `fake-guardian.ts` seeds it from a fixture and runs it on the frozen
 *   clock with real-length countdowns.
 *
 * It implements `GuardianClient` directly: answers are validated-shape objects (the tests
 * check them with the shared response validators) and errors are `GuardianApiError`s with
 * the guardian's codes and statuses. Every call first runs the time-driven step (blocks
 * that ended complete and earn points, emergencies become ready or expire), like the real
 * engine does before each request. There is no operation that ends a block early.
 */
import { createHash, randomBytes } from 'node:crypto';
import { CATALOG_VERSION, getApp, getService } from '@centrate/shared/catalog';
import type {
  Block,
  BlockId,
  BlockMode,
  EmergencyId,
  EmergencyUnlock,
  EpochId,
  EventDataMap,
  EventType,
  ExtensionId,
  GuardianEvent,
  GuardianSettings,
  PendingSettingChange,
  PointsSummary,
  Punishment,
  RewardAllowance,
  RewardsLockReason,
  Schedule,
  ScheduleId,
  StudySessionId,
  WireEvent,
} from '@centrate/shared/domain';
import {
  DATA_DELETE_CONFIRM_WORDS,
  DEFAULT_GUARDIAN_SETTINGS,
  GUARDIAN_API_VERSION,
  GUARDIAN_CAPABILITIES,
  GUARDIAN_ERROR_STATUS,
  GUARDIAN_LIMITS,
  GUARDIAN_NAME,
  GuardianApiError,
  createBlockRequestSchema,
  emptyAllow,
  isEmergencyRequest,
  isScheduleInput,
  isSettingsRequest,
  validateRequest,
  validationErrorCode,
  type AttemptRequest,
  type AttemptResponse,
  type ConfirmEmergencyRequest,
  type ConfirmEmergencyResponse,
  type CreateBlockRequest,
  type CreateBlockResponse,
  type CurrentStudyResponse,
  type DeleteDataRequest,
  type DeleteDataResponse,
  type DiagnosticsResponse,
  type EmergencyPreviewResponse,
  type EmergencyRequest,
  type EmergencyResponse,
  type EndedBlockNotice,
  type EventsQuery,
  type EventsResponse,
  type ExtendBlockRequest,
  type ExtendBlockResponse,
  type GetBlockResponse,
  type GuardianClient,
  type GuardianErrorCode,
  type GuardianStateResponse,
  type HealthResponse,
  type ListBlocksQuery,
  type ListBlocksResponse,
  type ListSchedulesResponse,
  type NuclearHeartbeatRequest,
  type NuclearHeartbeatResponse,
  type PairedExtension,
  type PairedExtensionsResponse,
  type PairingCodeResponse,
  type PointsResponse,
  type RedeemRewardRequest,
  type RedeemRewardResponse,
  type RewardsResponse,
  type ScheduleInput,
  type ScheduleResponse,
  type SettingsResponse,
  type StateResult,
  type StudySessionDetailResponse,
  type WriteOptions,
} from '@centrate/shared/guardian-api';
import {
  EMERGENCY_RULES,
  RULES_VERSION,
  allowanceRefund,
  attemptPenalty,
  blockCompletionPoints,
  emergencyCountdownMinutes,
  emergencyPenalty,
  emergencyPhraseMatches,
  levelForXp,
  nextEscalationIndex,
  xpForLevel,
} from '@centrate/shared/points';
import type { Clock, TimerHandle } from '../contracts';
import { checkRedeem, rewardsShop } from './mock-rewards';
import { applyDuePending, applySettingsPut } from './mock-settings';

const MIN = 60_000;

export const MOCK_GUARDIAN_ENV = 'CENTRATE_MOCK_GUARDIAN';
export const MOCK_GUARDIAN_VERSION = '0.1.0';

/** `CENTRATE_MOCK_GUARDIAN=1` on an unpackaged app. */
export function mockGuardianEnabled(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): boolean {
  return !packaged && env[MOCK_GUARDIAN_ENV] === '1';
}

/** What a fixture seeds (all optional: a fresh mock starts empty). */
export interface MockSeed {
  state?: GuardianStateResponse | null;
  health?: HealthResponse;
  settings?: SettingsResponse;
  schedules?: Schedule[];
  pairingCode?: PairingCodeResponse;
  extensions?: PairedExtension[];
  /** Served for `emergencyPreview()` while nothing changed since the seed. */
  emergencyPreview?: EmergencyPreviewResponse;
  /** Served for `listRewards()` while nothing changed since the seed (Phase 5). */
  rewards?: RewardsResponse;
}

export interface MockGuardianOptions {
  clock: Clock;
  /**
   * Length of one «countdown minute» of an emergency: 60 000 (harness, real length) or
   * 1 000 (dev mock: 10 s for normal blocks, 30 s for strict ones).
   */
  emergencyUnitMs?: number;
  seed?: MockSeed | null;
  /** Deterministic ids/keys (tests). */
  random?: (bytes: number) => Buffer;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function apiError(
  code: GuardianErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): GuardianApiError {
  return new GuardianApiError(GUARDIAN_ERROR_STATUS[code], code, message, details);
}

function localDay(ms: number, timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sortBlocks(blocks: Block[]): Block[] {
  return blocks.sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt));
}

interface IdempotencyRecord {
  fingerprint: string;
  response: unknown;
}

interface Waiter {
  after: number;
  wake: () => void;
}

function defaultPoints(day: string): PointsSummary {
  return {
    balance: 0,
    xp: 0,
    level: 1,
    levelFloorXp: 0,
    nextLevelXp: xpForLevel(2),
    streakDays: 0,
    bestStreakDays: 0,
    today: { day, focusMinutes: 0, goalMinutes: DEFAULT_GUARDIAN_SETTINGS.dailyGoalMinutes, goalMet: false },
    pendingFocusMinutes: 0,
  };
}

function defaultSettings(): GuardianSettings {
  return {
    ...DEFAULT_GUARDIAN_SETTINGS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    punishment: { ...DEFAULT_GUARDIAN_SETTINGS.punishment },
    studyWhitelist: { extraDomains: [], extraProcesses: [] },
  };
}

export class MockGuardian implements GuardianClient {
  private readonly clock: Clock;
  private readonly unitMs: number;
  private readonly random: (bytes: number) => Buffer;

  private epoch: EpochId;
  private seq: number;
  private version: number;
  private readonly seedVersion: number;
  private base: GuardianStateResponse;
  private blocks: Block[];
  private punishments: Punishment[];
  private emergency: EmergencyUnlock | null;
  private rewardsLock: RewardsLockReason | null;
  private points: PointsSummary;
  private ended: EndedBlockNotice[];
  private endedBlocks: Block[] = [];
  private events: WireEvent[] = [];
  private settings: GuardianSettings;
  private schedules: Schedule[];
  private extensions: PairedExtension[];
  private health0: HealthResponse;
  private seedPairing: PairingCodeResponse | null;
  private seedPreview: EmergencyPreviewResponse | null;
  private seedRewards: RewardsResponse | null;
  private allowances: RewardAllowance[];
  private pendingSettings: PendingSettingChange[];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private waiters: Waiter[] = [];
  private escalation: { lastCountedAtMs: number | null; index: number } = {
    lastCountedAtMs: null,
    index: 0,
  };
  private readonly startedAt: number;

  constructor(options: MockGuardianOptions) {
    this.clock = options.clock;
    this.unitMs = options.emergencyUnitMs ?? 1_000;
    this.random = options.random ?? randomBytes;
    const now = this.clock.now();
    const seed = options.seed ?? null;
    const state = seed?.state ?? null;
    this.startedAt = now - 60 * MIN;
    this.settings = clone(seed?.settings?.settings ?? defaultSettings());
    this.epoch = state?.epoch ?? (this.newId('ep') as EpochId);
    this.seq = state?.lastEventSeq ?? 0;
    this.version = state?.stateVersion ?? now;
    this.seedVersion = this.version;
    this.blocks = clone(state?.blocks ?? []);
    this.punishments = clone(state?.punishments ?? []);
    this.emergency = clone(state?.emergency ?? null);
    this.rewardsLock = state?.rewardsLock ?? null;
    this.points = clone(state?.points ?? defaultPoints(localDay(now, this.settings.timezone)));
    this.ended = clone(state?.recent.endedBlocks ?? []);
    this.schedules = clone(seed?.schedules ?? []);
    this.extensions = clone(seed?.extensions ?? []);
    this.seedPairing = seed?.pairingCode ? clone(seed.pairingCode) : null;
    this.seedPreview = seed?.emergencyPreview ? clone(seed.emergencyPreview) : null;
    this.seedRewards = seed?.rewards ? clone(seed.rewards) : null;
    this.allowances = clone(state?.allowances ?? []);
    this.pendingSettings = clone(seed?.settings?.pending ?? state?.pendingSettings ?? []);
    this.health0 = clone(seed?.health ?? this.defaultHealth(now));
    this.base = clone(state ?? this.emptyState(now));
    if (!state) {
      this.emit('epoch_started', {
        reason: 'install',
        previousEpoch: null,
        carryOverBalance: 0,
        escalation: { lastCountedAt: null, index: 0 },
        kept: {
          blocks: [],
          punishments: [],
          allowances: [],
          schedules: [],
          settings: clone(this.settings),
          pendingSettings: [],
          materializedOccurrences: [],
        },
      });
    }
  }

  // -------------------------------------------------------------------------------------
  // Test and dev helpers
  // -------------------------------------------------------------------------------------

  /** Current `ETag` of `/v1/state`. */
  etag(): string {
    return `"s-${this.version}"`;
  }

  /** Every event held (the mock keeps only what it emitted itself). */
  allEvents(): WireEvent[] {
    return clone(this.events);
  }

  /** Wake every long poll (shutdown). */
  close(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.wake();
  }

  // -------------------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------------------

  private newId(prefix: string): string {
    const bytes = this.random(22);
    let body = '';
    for (let i = 0; i < 22; i += 1) body += B62[(bytes[i] ?? 0) % 62];
    return `${prefix}_${body}`;
  }

  private defaultHealth(now: number): HealthResponse {
    return {
      ok: true,
      name: GUARDIAN_NAME,
      version: MOCK_GUARDIAN_VERSION,
      apiVersion: GUARDIAN_API_VERSION,
      capabilities: [...GUARDIAN_CAPABILITIES],
      schemaVersion: 1,
      catalogVersion: CATALOG_VERSION,
      rulesVersion: RULES_VERSION,
      startedAt: iso(now - 60 * MIN),
      serverNow: iso(now),
      mode: 'normal',
      problems: [],
    };
  }

  private emptyState(now: number): GuardianStateResponse {
    return {
      stateVersion: this.version,
      serverNow: iso(now),
      epoch: this.epoch,
      lastEventSeq: this.seq,
      guardian: { version: MOCK_GUARDIAN_VERSION, apiVersion: GUARDIAN_API_VERSION, mode: 'normal', problems: [] },
      clock: {
        wallOffsetMs: 0,
        trust: 'verified',
        lastJump: null,
        lastCalibratedAt: iso(now - 30 * MIN),
        bootHoldUntil: null,
      },
      protection: {
        hosts: { ok: true, status: 'ok', entries: 0, lastAppliedAt: null },
        processWatcher: { ok: true },
        extensions: [],
        browsersWithoutExtension: [],
      },
      blocks: [],
      punishments: [],
      nuclearActive: false,
      study: null,
      emergency: null,
      allowances: [],
      rewardsLock: null,
      nextSchedule: null,
      points: defaultPoints(localDay(now, null)),
      pendingSettings: [],
      recent: { endedBlocks: [], endedStudy: null },
    };
  }

  private changed(): void {
    this.version += 1;
  }

  private emit<K extends EventType>(
    type: K,
    data: EventDataMap[K],
    options: { points?: number; xp?: number; txEnd?: boolean; key?: string | null } = {},
  ): void {
    const now = this.clock.now();
    this.seq += 1;
    const event = {
      v: 1,
      epoch: this.epoch,
      seq: this.seq,
      at: iso(now),
      wallOffsetMs: 0,
      day: localDay(now, this.settings.timezone),
      points: options.points ?? 0,
      xp: options.xp ?? 0,
      txEnd: options.txEnd ?? true,
      req: options.key ? createHash('sha256').update(options.key).digest('hex').slice(0, 32) : null,
      type,
      data: clone(data),
    } as GuardianEvent;
    this.events.push(event);
    if (this.events.length > 5_000) this.events.splice(0, this.events.length - 5_000);
    const ready = this.waiters.filter((w) => this.seq > w.after);
    this.waiters = this.waiters.filter((w) => this.seq <= w.after);
    for (const w of ready) w.wake();
  }

  private addPoints(delta: number, xp = 0): void {
    const p = this.points;
    const nextXp = p.xp + xp;
    const level = levelForXp(nextXp);
    this.points = {
      ...p,
      balance: p.balance + delta,
      xp: nextXp,
      level,
      levelFloorXp: xpForLevel(level),
      nextLevelXp: xpForLevel(level + 1),
    };
  }

  private bootHoldActive(now: number): boolean {
    const hold = this.base.clock.bootHoldUntil;
    return hold !== null && Date.parse(hold) > now;
  }

  /** Time-driven step (runs before every call). */
  private step(): void {
    const now = this.clock.now();
    let dirty = false;
    // Blocks whose end passed complete (never during a boot hold).
    if (!this.bootHoldActive(now)) {
      const due = this.blocks.filter((b) => Date.parse(b.endsAt) <= now);
      for (const block of due) {
        dirty = true;
        this.blocks = this.blocks.filter((b) => b.id !== block.id);
        const credited = Math.max(
          0,
          Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / MIN),
        );
        const points = blockCompletionPoints(block.kind, credited, block.attemptsCounted).total;
        this.addPoints(points);
        const endedBlock: Block = {
          ...block,
          status: 'completed',
          endedAt: block.endsAt,
          pointsDelta: points,
        };
        this.endedBlocks.unshift(endedBlock);
        this.ended.unshift({
          id: block.id,
          kind: block.kind,
          mode: block.mode,
          outcome: 'completed',
          endedAt: block.endsAt,
          pointsDelta: points,
        });
        const punishment = this.punishments.find((p) => p.blockId === block.id) ?? null;
        this.emit(
          'block_completed',
          {
            blockId: block.id,
            kind: block.kind,
            mode: block.mode,
            creditedMinutes: credited,
            attemptsCounted: block.attemptsCounted,
            downtimeMs: 0,
            clockTrust: 'verified',
          },
          { points, txEnd: punishment === null },
        );
        if (punishment) {
          this.punishments = this.punishments.filter((p) => p.id !== punishment.id);
          this.emit('punishment_ended', {
            punishmentId: punishment.id,
            blockId: block.id,
            outcome: 'completed',
          });
        }
      }
      if (due.length > 0) this.rewardsLock = this.currentLock();
    }
    // Emergency: counting → ready → expired; moot when its blocks are gone.
    const e = this.emergency;
    if (e) {
      const alive = e.blockIds.filter((id) => this.blocks.some((b) => b.id === id));
      if (alive.length === 0) {
        dirty = true;
        this.finishEmergency('cancelled', 'blocks_ended');
      } else if (e.status === 'counting' && Date.parse(e.readyAt) <= now) {
        dirty = true;
        this.emergency = {
          ...e,
          status: 'ready',
          confirmBy: iso(Date.parse(e.readyAt) + EMERGENCY_RULES.confirmWindowMinutes * MIN),
        };
      } else if (e.status === 'ready' && e.confirmBy && Date.parse(e.confirmBy) < now) {
        dirty = true;
        this.finishEmergency('expired', 'expired');
      }
    }
    // Reward allowances end on time.
    const expired = this.allowances.filter(
      (a) => a.status === 'active' && Date.parse(a.endsAt) <= now,
    );
    for (const a of expired) {
      dirty = true;
      this.allowances = this.allowances.filter((x) => x.id !== a.id);
      this.emit('reward_ended', {
        allowanceId: a.id,
        serviceId: a.serviceId,
        reason: 'expired',
        revokedByBlockId: null,
        cost: a.cost,
        totalMs: Date.parse(a.endsAt) - Date.parse(a.startedAt),
        remainingMs: 0,
        refund: 0,
      });
    }
    // Weakening settings changes whose 24 h passed.
    const due = applyDuePending(this.settings, this.pendingSettings, now);
    if (due) {
      dirty = true;
      this.settings = due.settings;
      this.pendingSettings = due.pending;
      this.emit('settings_changed', { settings: clone(this.settings), pending: clone(due.pending) });
    }
    // «Hecho» notices live 2 min.
    const keep = this.ended.filter(
      (n) => now - Date.parse(n.endedAt) < GUARDIAN_LIMITS.recentEndedBlocksMs,
    );
    if (keep.length !== this.ended.length) {
      this.ended = keep;
      dirty = true;
    }
    // Today's day (goal bar) follows the local day.
    const day = localDay(now, this.settings.timezone);
    if (this.points.today.day !== day) {
      this.points = {
        ...this.points,
        today: { day, focusMinutes: 0, goalMinutes: this.settings.dailyGoalMinutes, goalMet: false },
      };
      dirty = true;
    }
    if (dirty) this.changed();
  }

  /** Nuclear punishments running (the overlay covers the screens). */
  private nuclearActive(): boolean {
    if (this.version === this.seedVersion) return this.base.nuclearActive;
    return this.punishments.some((p) => p.level === 'nuclear' && p.status === 'active');
  }

  /**
   * A hardcore or exam block (or a punishment) revokes every active allowance in the same batch,
   * refunding the unused part (ARCHITECTURE §10.7).
   */
  private revokeAllowances(blockId: BlockId): void {
    const now = this.clock.now();
    const active = this.allowances.filter((a) => a.status === 'active');
    active.forEach((a, i) => {
      const totalMs = Date.parse(a.endsAt) - Date.parse(a.startedAt);
      const remainingMs = Math.max(0, Date.parse(a.endsAt) - now);
      const refund = allowanceRefund(a.cost, totalMs, remainingMs);
      this.addPoints(refund);
      this.emit(
        'reward_ended',
        {
          allowanceId: a.id,
          serviceId: a.serviceId,
          reason: 'revoked',
          revokedByBlockId: blockId,
          cost: a.cost,
          totalMs,
          remainingMs,
          refund,
        },
        { points: refund, txEnd: i === active.length - 1 },
      );
    });
    this.allowances = this.allowances.filter((a) => a.status !== 'active');
  }

  /** Why the reward shop is locked right now (PROMPT §7). */
  private currentLock(): RewardsLockReason | null {
    if (this.emergency) return 'emergency';
    if (this.punishments.length > 0) return 'punishment';
    if (this.blocks.some((b) => b.mode === 'exam')) return 'exam';
    if (this.blocks.some((b) => b.mode === 'hardcore')) return 'hardcore';
    return null;
  }

  private finishEmergency(
    status: 'cancelled' | 'expired',
    reason: 'user' | 'expired' | 'blocks_ended',
  ): EmergencyUnlock | null {
    const e = this.emergency;
    if (!e) return null;
    const done: EmergencyUnlock = {
      ...e,
      status,
      resolvedAt: iso(this.clock.now()),
      cancelReason: reason,
    };
    this.emergency = null;
    this.blocks = this.blocks.map((b) =>
      e.blockIds.includes(b.id) ? { ...b, emergencyEligible: isEligibleMode(b.mode) } : b,
    );
    this.rewardsLock = this.currentLock();
    this.emit('emergency_cancelled', { emergencyId: e.id, reason });
    return done;
  }

  private idem<T>(scope: string, key: string | undefined, body: unknown, run: () => T): T {
    if (!key) return run();
    const id = `${scope}|${key}`;
    const fingerprint = JSON.stringify(body ?? null);
    const existing = this.idempotency.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw apiError('idempotency_conflict', 'idempotency key reused with another body');
      }
      return clone(existing.response) as T;
    }
    // Keys are per path: a key reused on another path is a conflict too.
    for (const [other] of this.idempotency) {
      if (other.endsWith(`|${key}`) && other !== id) {
        throw apiError('idempotency_conflict', 'idempotency key reused on another path');
      }
    }
    const response = run();
    this.idempotency.set(id, { fingerprint, response: clone(response) });
    if (this.idempotency.size > GUARDIAN_LIMITS.idempotencyMaxEntries) {
      const first = this.idempotency.keys().next().value;
      if (first !== undefined) this.idempotency.delete(first);
    }
    return response;
  }

  private writable(): void {
    if (this.base.guardian.mode !== 'normal') {
      throw apiError('read_only', 'guardian is read-only', { reason: 'safe_mode' });
    }
  }

  private stateBody(): GuardianStateResponse {
    const now = this.clock.now();
    return clone({
      ...this.base,
      stateVersion: this.version,
      serverNow: iso(now),
      epoch: this.epoch,
      lastEventSeq: this.seq,
      protection: {
        ...this.base.protection,
        hosts:
          this.version === this.seedVersion
            ? this.base.protection.hosts
            : {
                ...this.base.protection.hosts,
                entries: this.blocks.length > 0 ? Math.max(1, this.base.protection.hosts.entries) : 0,
              },
      },
      blocks: sortBlocks([...this.blocks]),
      punishments: [...this.punishments].sort(
        (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt),
      ),
      emergency: this.emergency,
      rewardsLock: this.rewardsLock,
      nuclearActive: this.nuclearActive(),
      // A seeded state is served exactly as the fixture wrote it until something changes.
      allowances: this.version === this.seedVersion ? this.base.allowances : this.allowances,
      pendingSettings:
        this.version === this.seedVersion ? this.base.pendingSettings : this.pendingSettings,
      points: this.points,
      recent: { endedBlocks: this.ended, endedStudy: null },
    });
  }

  // -------------------------------------------------------------------------------------
  // GuardianClient
  // -------------------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    return clone({ ...this.health0, serverNow: iso(this.clock.now()) });
  }

  async getState(options?: { etag?: string | null }): Promise<StateResult> {
    this.step();
    const etag = this.etag();
    if (options?.etag && options.etag === etag) return { notModified: true, etag };
    return { notModified: false, etag, state: this.stateBody() };
  }

  async diagnostics(): Promise<DiagnosticsResponse> {
    this.step();
    const now = this.clock.now();
    return {
      guardian: {
        version: this.health0.version,
        commit: 'mock',
        goVersion: 'none',
        os: process.platform,
        arch: process.arch,
        serviceManager: 'mock',
        pid: process.pid,
        port: 47600,
        startedAt: iso(this.startedAt),
        uptimeMs: Math.max(0, now - this.startedAt),
        mode: this.base.guardian.mode,
      },
      state: {
        schemaVersion: 1,
        epoch: this.epoch,
        lastEventSeq: this.seq,
        integrity: 'ok',
        stateBytes: 0,
        eventsBytes: 0,
      },
      clock: {
        wallOffsetMs: 0,
        trust: 'verified',
        bootClock: 'mock',
        awakeClock: 'mock',
        jumps24h: 0,
        lastCalibration: null,
      },
      hosts: {
        path: 'mock',
        pathOverridden: false,
        status: 'ok',
        entries: 0,
        lastWriteAt: null,
        lastVerifyAt: null,
        tamper24h: 0,
        lastFlush: null,
      },
      processWatcher: { intervalMs: 1_500, lastScanMs: 0, kills24h: 0 },
      extensions: clone(this.base.protection.extensions),
      catalogVersion: CATALOG_VERSION,
      rulesVersion: RULES_VERSION,
      errors: [],
    };
  }

  async createBlock(body: CreateBlockRequest, options?: WriteOptions): Promise<CreateBlockResponse> {
    this.step();
    return this.idem('POST /v1/blocks', options?.idempotencyKey, body, () => {
      this.writable();
      const shape = validateRequest(createBlockRequestSchema, body);
      if (!shape.ok) {
        const code = validationErrorCode(shape.issue);
        throw apiError(code, shape.issue.message, {
          path: shape.issue.path,
          issue: shape.issue.issue,
          ...(code === 'duration_out_of_range'
            ? { minMinutes: GUARDIAN_LIMITS.blockMinMinutes, maxMinutes: GUARDIAN_LIMITS.blockMaxMinutes }
            : {}),
        });
      }
      const now = this.clock.now();
      const minutes =
        body.durationMinutes ?? Math.ceil((Date.parse(body.endsAt ?? '') - now) / MIN);
      if (
        !Number.isFinite(minutes) ||
        minutes < GUARDIAN_LIMITS.blockMinMinutes ||
        minutes > GUARDIAN_LIMITS.blockMaxMinutes
      ) {
        throw apiError('duration_out_of_range', 'duration out of range', {
          minMinutes: GUARDIAN_LIMITS.blockMinMinutes,
          maxMinutes: GUARDIAN_LIMITS.blockMaxMinutes,
        });
      }
      const needs: string[] = [];
      if (minutes > GUARDIAN_LIMITS.longBlockConfirmMinutes && !body.acknowledgeLong) needs.push('long');
      if ((body.mode === 'hardcore' || body.mode === 'exam') && !body.acknowledgeNoEmergency) {
        needs.push('no_emergency');
      }
      if (needs.length > 0) throw apiError('confirmation_required', 'confirmation required', { needs });
      body.targets.serviceIds.forEach((id, i) => {
        if (!getService(id)) {
          throw apiError('unknown_id', 'unknown service', { path: `targets.serviceIds.${i}`, id });
        }
      });
      body.targets.appIds.forEach((id, i) => {
        if (!getApp(id)) throw apiError('unknown_id', 'unknown app', { path: `targets.appIds.${i}`, id });
      });
      if (this.blocks.length >= GUARDIAN_LIMITS.maxActiveBlocks) {
        throw apiError('too_many_targets', 'too many active blocks');
      }
      const endsAtMs = body.durationMinutes !== null ? now + body.durationMinutes * MIN : Date.parse(body.endsAt ?? '');
      const block: Block = {
        id: this.newId('blk') as BlockId,
        kind: 'manual',
        mode: body.mode,
        status: 'active',
        targets: clone(body.targets),
        whitelistOnly: body.whitelistOnly,
        allow: clone(body.allow),
        reason: body.reason,
        createdAt: iso(now),
        startsAt: iso(now),
        endsAt: iso(endsAtMs),
        originalEndsAt: iso(endsAtMs),
        endedAt: null,
        extendedMinutes: 0,
        scheduleId: null,
        punishmentId: null,
        attemptsCounted: 0,
        emergencyEligible: isEligibleMode(body.mode),
        pointsDelta: null,
      };
      this.blocks = sortBlocks([...this.blocks, block]);
      this.rewardsLock = this.currentLock();
      const revokes =
        (body.mode === 'hardcore' || body.mode === 'exam') &&
        this.allowances.some((a) => a.status === 'active');
      this.emit(
        'block_created',
        { block, source: 'user' },
        { key: options?.idempotencyKey ?? null, txEnd: !revokes },
      );
      if (revokes) this.revokeAllowances(block.id);
      this.changed();
      return { block: clone(block), stateVersion: this.version };
    });
  }

  async listBlocks(query?: ListBlocksQuery): Promise<ListBlocksResponse> {
    this.step();
    const blocks = query?.status === 'ended' ? this.endedBlocks : sortBlocks([...this.blocks]);
    const limit = Math.min(query?.limit ?? 50, GUARDIAN_LIMITS.blocksPageMax);
    return { blocks: clone(blocks.slice(0, limit)), nextCursor: null };
  }

  async getBlock(id: BlockId): Promise<GetBlockResponse> {
    this.step();
    const block = this.blocks.find((b) => b.id === id) ?? this.endedBlocks.find((b) => b.id === id);
    if (!block) throw apiError('not_found', 'no such block');
    const credited = Math.max(
      0,
      Math.floor((Math.min(this.clock.now(), Date.parse(block.endsAt)) - Date.parse(block.startsAt)) / MIN),
    );
    return { block: clone(block), progress: { creditedMinutes: credited, downtimeMs: 0 } };
  }

  async extendBlock(
    id: BlockId,
    body: ExtendBlockRequest,
    options?: WriteOptions,
  ): Promise<ExtendBlockResponse> {
    this.step();
    return this.idem(`POST /v1/blocks/${id}/extend`, options?.idempotencyKey, body, () => {
      this.writable();
      const add = body?.addMinutes;
      if (
        typeof add !== 'number' ||
        !Number.isInteger(add) ||
        add < 1 ||
        add > GUARDIAN_LIMITS.extendMaxAddMinutes
      ) {
        throw apiError('validation_failed', 'addMinutes out of range', { path: 'addMinutes', issue: 'range' });
      }
      const block = this.blocks.find((b) => b.id === id);
      if (!block) {
        const ended = this.endedBlocks.find((b) => b.id === id);
        if (ended) throw apiError('block_not_active', 'block ended', { status: ended.status });
        throw apiError('not_found', 'no such block');
      }
      if (block.kind === 'punishment') throw apiError('not_extendable', 'punishments cannot be extended');
      const now = this.clock.now();
      const remainingMin = (Date.parse(block.endsAt) - now) / MIN;
      if (remainingMin + add > GUARDIAN_LIMITS.blockMaxMinutes) {
        throw apiError('extension_exceeds_max', 'at most 24 h remaining', {
          maxAddMinutes: Math.max(0, Math.floor(GUARDIAN_LIMITS.blockMaxMinutes - remainingMin)),
        });
      }
      const endsAt = iso(Date.parse(block.endsAt) + add * MIN);
      const next: Block = { ...block, endsAt, extendedMinutes: block.extendedMinutes + add };
      this.blocks = sortBlocks(this.blocks.map((b) => (b.id === id ? next : b)));
      this.emit('block_extended', { blockId: id, addMinutes: add, endsAt }, { key: options?.idempotencyKey ?? null });
      this.changed();
      return { block: clone(next), stateVersion: this.version };
    });
  }

  async listSchedules(): Promise<ListSchedulesResponse> {
    this.step();
    return { schedules: clone(this.schedules) };
  }

  async createSchedule(body: ScheduleInput, options?: WriteOptions): Promise<ScheduleResponse> {
    this.step();
    return this.idem('POST /v1/schedules', options?.idempotencyKey, body, () => {
      this.writable();
      if (!isScheduleInput(body)) throw apiError('validation_failed', 'invalid schedule');
      if (this.schedules.length >= GUARDIAN_LIMITS.maxSchedules) {
        throw apiError('validation_failed', 'too many schedules');
      }
      const now = iso(this.clock.now());
      const schedule: Schedule = {
        id: this.newId('sch') as ScheduleId,
        ...scheduleFields(body),
        createdAt: now,
        updatedAt: now,
        nextOccurrence: null,
        activeBlockId: null,
      };
      this.schedules.push(schedule);
      this.emit('schedule_created', { schedule });
      this.changed();
      return { schedule: clone(schedule) };
    });
  }

  async updateSchedule(id: ScheduleId, body: ScheduleInput): Promise<ScheduleResponse> {
    this.step();
    this.writable();
    if (!isScheduleInput(body)) throw apiError('validation_failed', 'invalid schedule');
    const index = this.schedules.findIndex((s) => s.id === id);
    const current = this.schedules[index];
    if (!current) throw apiError('not_found', 'no such schedule');
    if (current.activeBlockId !== null) {
      throw apiError('schedule_in_progress', 'schedule in progress', { activeBlockId: current.activeBlockId });
    }
    const schedule: Schedule = {
      ...current,
      ...scheduleFields(body),
      updatedAt: iso(this.clock.now()),
      nextOccurrence: body.enabled ? current.nextOccurrence : null,
    };
    this.schedules[index] = schedule;
    this.emit('schedule_updated', { schedule });
    this.changed();
    return { schedule: clone(schedule) };
  }

  async deleteSchedule(id: ScheduleId): Promise<void> {
    this.step();
    this.writable();
    const current = this.schedules.find((s) => s.id === id);
    if (!current) throw apiError('not_found', 'no such schedule');
    if (current.activeBlockId !== null) throw apiError('schedule_in_progress', 'schedule in progress');
    this.schedules = this.schedules.filter((s) => s.id !== id);
    this.emit('schedule_deleted', { scheduleId: id });
    this.changed();
  }

  async startStudy(): Promise<never> {
    throw apiError('not_found', 'study mode is not simulated');
  }

  async currentStudy(): Promise<CurrentStudyResponse> {
    return { session: null };
  }

  async getStudySession(_id: StudySessionId): Promise<StudySessionDetailResponse> {
    throw apiError('not_found', 'no such session');
  }

  async studyHeartbeat(): Promise<never> {
    throw apiError('study_not_active', 'no study session');
  }

  async studyStrike(): Promise<never> {
    throw apiError('study_not_active', 'no study session');
  }

  async pauseStudy(): Promise<never> {
    throw apiError('study_not_active', 'no study session');
  }

  async resumeStudy(): Promise<never> {
    throw apiError('study_not_active', 'no study session');
  }

  async endStudy(): Promise<never> {
    throw apiError('study_not_active', 'no study session');
  }

  async setStudyOutcome(): Promise<never> {
    throw apiError('outcome_window_closed', 'no study session');
  }

  /** Window-layer attempts (the mock counts them like the guardian: dedupe aside). */
  async reportAttempt(body: AttemptRequest): Promise<AttemptResponse> {
    this.step();
    const now = this.clock.now();
    const serviceId = body.target.type === 'service' ? body.target.value : null;
    const service = serviceId ? getService(serviceId) : undefined;
    const covering = this.blocks.filter(
      (b) =>
        !b.whitelistOnly &&
        service !== undefined &&
        (b.targets.serviceIds.includes(service.id) ||
          b.targets.categoryIds.some((c) => service.categories.includes(c))),
    );
    const top = covering[0] ?? null;
    const nextPenalty = attemptPenalty(nextEscalationIndex(this.escalation, now));
    const opened =
      serviceId !== null &&
      this.allowances.some((a) => a.serviceId === serviceId && a.status === 'active');
    if (top && opened) {
      return {
        blocked: false,
        counted: false,
        merged: false,
        attemptId: null,
        pointsDelta: 0,
        episodePointsDelta: 0,
        escalationIndex: null,
        nextPenalty,
        serviceId,
        block: null,
        reason: 'allowance_active',
      };
    }
    if (!top) {
      return {
        blocked: false,
        counted: false,
        merged: false,
        attemptId: null,
        pointsDelta: 0,
        episodePointsDelta: 0,
        escalationIndex: null,
        nextPenalty,
        serviceId,
        block: null,
        reason: 'not_blocked',
      };
    }
    const index = nextEscalationIndex(this.escalation, now);
    const penalized = this.settings.attemptPenalties;
    const penalty = penalized ? attemptPenalty(index) : 0;
    this.escalation = { lastCountedAtMs: now, index };
    const attemptId = this.newId('att') as `att_${string}`;
    this.blocks = this.blocks.map((b) =>
      covering.some((c) => c.id === b.id) ? { ...b, attemptsCounted: b.attemptsCounted + 1 } : b,
    );
    this.addPoints(-penalty);
    this.emit(
      'attempt',
      {
        attemptId,
        layer: body.layer,
        targetKey: `svc:${serviceId ?? 'unknown'}`,
        targetType: 'service',
        serviceId,
        blockIds: covering.map((b) => b.id),
        browser: body.browser,
        incognito: body.incognito,
        escalationIndex: index,
        penalized,
      },
      { points: -penalty },
    );
    this.changed();
    return {
      blocked: true,
      counted: true,
      merged: false,
      attemptId,
      pointsDelta: -penalty,
      episodePointsDelta: -penalty,
      escalationIndex: index,
      nextPenalty: attemptPenalty(Math.min(index + 1, 3)),
      serviceId,
      block: { id: top.id, kind: top.kind, mode: top.mode, endsAt: top.endsAt, reason: top.reason },
      reason: null,
    };
  }

  async getPoints(): Promise<PointsResponse> {
    this.step();
    return { points: clone(this.points) };
  }

  async getEvents(query?: EventsQuery): Promise<EventsResponse> {
    this.step();
    const reset = query?.epoch !== this.epoch;
    const after = reset ? 0 : Math.max(0, Math.trunc(query?.after ?? 0));
    const limit = Math.min(
      Math.max(1, Math.trunc(query?.limit ?? GUARDIAN_LIMITS.eventsPageDefault)),
      GUARDIAN_LIMITS.eventsPageMax,
    );
    const waitMs = Math.min(Math.max(0, query?.waitMs ?? 0), GUARDIAN_LIMITS.longPollMaxMs);
    const epochAtStart = this.epoch;
    if (!reset && waitMs > 0 && this.seq <= after) {
      await new Promise<void>((resolve) => {
        let timer: TimerHandle | null = null;
        const waiter: Waiter = {
          after,
          wake: () => {
            if (timer !== null) this.clock.clearTimeout(timer);
            resolve();
          },
        };
        timer = this.clock.setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve();
        }, waitMs);
        this.waiters.push(waiter);
      });
      this.step();
      if (this.epoch !== epochAtStart) {
        // Data deletion during the long poll: answer with the new epoch's reset page.
        return this.getEvents({ limit, waitMs: 0 });
      }
    }
    const pending = this.events.filter((e) => e.seq > after && e.epoch === this.epoch);
    const page = pending.slice(0, limit);
    // A page never splits a batch: extend to the batch end if needed.
    let end = page.length;
    while (end > 0 && end < pending.length && !(pending[end - 1] as { txEnd: boolean }).txEnd) end += 1;
    const events = pending.slice(0, end);
    const last = events[events.length - 1];
    return {
      epoch: this.epoch,
      reset,
      events: clone(events),
      lastSeq: last ? last.seq : after,
      hasMore: pending.length > events.length,
    };
  }

  async emergencyPreview(blockIds?: readonly BlockId[]): Promise<EmergencyPreviewResponse> {
    this.step();
    if (this.seedPreview && this.version === this.seedVersion && (!blockIds || blockIds.length === 0)) {
      return clone(this.seedPreview);
    }
    const balance = this.points.balance;
    const excluded = this.blocks.filter((b) => !isEligibleMode(b.mode)).map((b) => b.id);
    const base = {
      excludedBlockIds: excluded,
      penaltyPoints: emergencyPenalty(balance),
      balance,
      allowanceValue: 0,
      streakDays: this.points.streakDays,
      phrases: { ...EMERGENCY_RULES.phrases },
    };
    if (this.emergency) {
      return { ...base, eligible: false, reason: 'emergency_in_progress', blockIds: [], countdownMinutes: null };
    }
    const wanted = blockIds && blockIds.length > 0 ? this.blocks.filter((b) => blockIds.includes(b.id)) : this.blocks;
    const eligible = wanted.filter((b) => b.emergencyEligible);
    if (eligible.length === 0) {
      const hard = wanted.find((b) => b.mode === 'hardcore' || b.mode === 'exam');
      return {
        ...base,
        eligible: false,
        reason: hard ? (hard.mode === 'exam' ? 'exam' : 'hardcore') : 'no_active_blocks',
        blockIds: [],
        countdownMinutes: null,
      };
    }
    return {
      ...base,
      eligible: true,
      reason: null,
      blockIds: eligible.map((b) => b.id),
      countdownMinutes: emergencyCountdownMinutes(eligible.map(effectiveMode)),
    };
  }

  async requestEmergency(body: EmergencyRequest, options?: WriteOptions): Promise<EmergencyResponse> {
    this.step();
    return this.idem('POST /v1/emergency', options?.idempotencyKey, body, () => {
      this.writable();
      if (!isEmergencyRequest(body)) throw apiError('validation_failed', 'invalid emergency request');
      if (!emergencyPhraseMatches(body.phrase)) throw apiError('phrase_mismatch', 'phrase does not match');
      if (this.emergency) throw apiError('emergency_in_progress', 'an emergency is pending');
      const listed = body.blockIds.map((id) => this.blocks.find((b) => b.id === id) ?? null);
      const bad = body.blockIds.filter((_, i) => {
        const b = listed[i];
        return !b || !b.emergencyEligible;
      });
      if (bad.length > 0 || listed.length === 0) {
        throw apiError('emergency_not_available', 'blocks not eligible', { reason: 'not_eligible', blockIds: bad });
      }
      const blocks = listed.filter((b): b is Block => b !== null);
      const countdown = emergencyCountdownMinutes(blocks.map(effectiveMode)) ?? EMERGENCY_RULES.countdownMinutes.normal;
      const now = this.clock.now();
      const emergency: EmergencyUnlock = {
        id: this.newId('emg') as EmergencyId,
        blockIds: blocks.map((b) => b.id),
        status: 'counting',
        countdownMinutes: countdown,
        requestedAt: iso(now),
        readyAt: iso(now + countdown * this.unitMs),
        confirmBy: null,
        penaltyPreview: emergencyPenalty(this.points.balance),
        streakDaysAtRisk: this.points.streakDays,
        resolvedAt: null,
        cancelReason: null,
      };
      this.emergency = emergency;
      this.rewardsLock = 'emergency';
      this.blocks = this.blocks.map((b) =>
        emergency.blockIds.includes(b.id) ? { ...b, emergencyEligible: false } : b,
      );
      this.emit('emergency_requested', { emergency }, { key: options?.idempotencyKey ?? null });
      this.changed();
      return { emergency: clone(emergency) };
    });
  }

  async cancelEmergency(id: EmergencyId): Promise<EmergencyResponse> {
    this.step();
    this.writable();
    const e = this.emergency;
    if (!e || e.id !== id) throw apiError('emergency_expired', 'no pending emergency with that id');
    const done = this.finishEmergency('cancelled', 'user');
    this.changed();
    if (!done) throw apiError('emergency_expired', 'no pending emergency');
    return { emergency: clone(done) };
  }

  async confirmEmergency(
    id: EmergencyId,
    body: ConfirmEmergencyRequest,
    options?: WriteOptions,
  ): Promise<ConfirmEmergencyResponse> {
    this.step();
    return this.idem(`POST /v1/emergency/${id}/confirm`, options?.idempotencyKey, body, () => {
      this.writable();
      if (body?.acknowledge !== true) throw apiError('validation_failed', 'acknowledge must be true');
      const e = this.emergency;
      if (!e || e.id !== id) throw apiError('emergency_expired', 'no pending emergency with that id');
      if (e.status === 'counting') throw apiError('emergency_not_ready', 'not ready yet', { readyAt: e.readyAt });
      const cancelled = this.blocks.filter((b) => e.blockIds.includes(b.id));
      if (cancelled.length === 0) {
        this.finishEmergency('cancelled', 'blocks_ended');
        this.changed();
        throw apiError('emergency_moot', 'blocks already ended');
      }
      const now = this.clock.now();
      const balanceBefore = this.points.balance;
      const penalty = emergencyPenalty(balanceBefore);
      const streakDaysLost = this.points.streakDays;
      this.addPoints(-penalty);
      this.points = { ...this.points, streakDays: 0 };
      const done: EmergencyUnlock = { ...e, status: 'confirmed', resolvedAt: iso(now) };
      this.emergency = null;
      this.blocks = this.blocks.filter((b) => !e.blockIds.includes(b.id));
      const punishments = this.punishments.filter((p) => e.blockIds.includes(p.blockId));
      this.punishments = this.punishments.filter((p) => !e.blockIds.includes(p.blockId));
      this.rewardsLock = this.currentLock();
      for (const b of cancelled) {
        this.endedBlocks.unshift({ ...b, status: 'cancelled_emergency', endedAt: iso(now), pointsDelta: 0 });
        this.ended.unshift({
          id: b.id,
          kind: b.kind,
          mode: b.mode,
          outcome: 'cancelled_emergency',
          endedAt: iso(now),
          pointsDelta: 0,
        });
      }
      const key = options?.idempotencyKey ?? null;
      this.emit(
        'emergency_confirmed',
        {
          emergencyId: e.id,
          blockIds: cancelled.map((b) => b.id),
          balanceBefore,
          allowanceValue: 0,
          penalty,
          streakDaysLost,
          goalMinutes: this.settings.dailyGoalMinutes,
        },
        { points: -penalty, txEnd: false, key },
      );
      cancelled.forEach((b, i) => {
        const last = i === cancelled.length - 1 && punishments.length === 0;
        this.emit(
          'block_cancelled',
          {
            blockId: b.id,
            emergencyId: e.id,
            forfeitedMinutes: Math.max(0, Math.round((now - Date.parse(b.startsAt)) / MIN)),
          },
          { txEnd: last, key },
        );
      });
      punishments.forEach((p, i) => {
        this.emit(
          'punishment_ended',
          { punishmentId: p.id, blockId: p.blockId, outcome: 'emergency' },
          { txEnd: i === punishments.length - 1, key },
        );
      });
      this.changed();
      return {
        emergency: clone(done),
        penaltyApplied: penalty,
        balanceAfter: this.points.balance,
        cancelledBlockIds: cancelled.map((b) => b.id),
        streakDaysLost,
      };
    });
  }

  private shopInput(): Parameters<typeof rewardsShop>[0] {
    return {
      balance: this.points.balance,
      blocks: this.blocks,
      allowances: this.allowances,
      lock: this.rewardsLock,
    };
  }

  async listRewards(): Promise<RewardsResponse> {
    this.step();
    if (this.seedRewards && this.version === this.seedVersion) return clone(this.seedRewards);
    return clone(rewardsShop(this.shopInput()));
  }

  async redeemReward(
    body: RedeemRewardRequest,
    options?: WriteOptions,
  ): Promise<RedeemRewardResponse> {
    this.step();
    return this.idem('POST /v1/rewards/redeem', options?.idempotencyKey, body, () => {
      this.writable();
      const offerId = typeof body?.offerId === 'string' ? body.offerId : '';
      const check = checkRedeem(offerId, this.shopInput());
      if (!check.ok) throw apiError(check.code, `redeem refused: ${check.code}`, check.details);
      const now = this.clock.now();
      const { offer, extend } = check;
      const allowance: RewardAllowance = extend
        ? {
            ...extend,
            minutes: extend.minutes + offer.minutes,
            cost: extend.cost + offer.cost,
            endsAt: iso(Date.parse(extend.endsAt) + offer.minutes * MIN),
          }
        : {
            id: this.newId('alw') as RewardAllowance['id'],
            offerId: offer.id,
            serviceId: offer.serviceId,
            minutes: offer.minutes,
            cost: offer.cost,
            startedAt: iso(now),
            endsAt: iso(now + offer.minutes * MIN),
            status: 'active',
            endedAt: null,
            refund: 0,
          };
      this.allowances = [...this.allowances.filter((a) => a.id !== allowance.id), allowance];
      this.addPoints(-offer.cost);
      this.emit(
        'reward_redeemed',
        {
          allowanceId: allowance.id,
          offerId: offer.id,
          serviceId: offer.serviceId,
          offerMinutes: offer.minutes,
          offerCost: offer.cost,
          allowanceMinutes: allowance.minutes,
          allowanceCost: allowance.cost,
          endsAt: allowance.endsAt,
          extendedExisting: extend !== null,
        },
        { points: -offer.cost, key: options?.idempotencyKey ?? null },
      );
      this.changed();
      return {
        allowance: clone(allowance),
        pointsDelta: -offer.cost,
        balanceAfter: this.points.balance,
      };
    });
  }

  async getSettings(): Promise<SettingsResponse> {
    this.step();
    return { settings: clone(this.settings), pending: clone(this.pendingSettings) };
  }

  async updateSettings(body: GuardianSettings): Promise<SettingsResponse> {
    this.step();
    this.writable();
    if (!isSettingsRequest(body)) throw apiError('validation_failed', 'invalid settings');
    const result = applySettingsPut(this.settings, this.pendingSettings, body, this.clock.now());
    this.settings = result.settings;
    this.pendingSettings = result.pending;
    this.points = {
      ...this.points,
      today: {
        ...this.points.today,
        goalMinutes: this.settings.dailyGoalMinutes,
        goalMet: this.points.today.focusMinutes >= this.settings.dailyGoalMinutes,
      },
    };
    this.emit('settings_changed', {
      settings: clone(this.settings),
      pending: clone(this.pendingSettings),
    });
    this.changed();
    return { settings: clone(this.settings), pending: clone(this.pendingSettings) };
  }

  async createPairingCode(): Promise<PairingCodeResponse> {
    this.step();
    this.writable();
    const expiresAt = iso(this.clock.now() + GUARDIAN_LIMITS.pairingCodeTtlMs);
    if (this.seedPairing) {
      const code = { ...this.seedPairing, expiresAt };
      this.seedPairing = null;
      return code;
    }
    const bytes = this.random(4);
    const n = (((bytes[0] ?? 0) << 16) | ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)) % 1_000_000;
    return { code: String(n).padStart(6, '0'), expiresAt, port: 47600 };
  }

  async claimPairing(): Promise<never> {
    throw apiError('pairing_no_code', 'pairing claims are not simulated');
  }

  async listExtensions(): Promise<PairedExtensionsResponse> {
    this.step();
    return { extensions: clone(this.extensions) };
  }

  async revokeExtension(id: ExtensionId): Promise<void> {
    this.step();
    if (!this.extensions.some((e) => e.id === id)) throw apiError('not_found', 'no such extension');
    this.extensions = this.extensions.filter((e) => e.id !== id);
    this.emit('extension_revoked', { extensionId: id });
    this.changed();
  }

  async getExtRules(): Promise<never> {
    throw apiError('insufficient_scope', 'extension rules need an extension token');
  }

  async extHeartbeat(): Promise<never> {
    throw apiError('insufficient_scope', 'extension heartbeats need an extension token');
  }

  /** The overlay's liveness (the mock has no supervisor: it only answers). */
  async nuclearHeartbeat(body: NuclearHeartbeatRequest): Promise<NuclearHeartbeatResponse> {
    this.step();
    if (
      typeof body?.overlayShown !== 'boolean' ||
      !Number.isInteger(body.displays) ||
      body.displays < 1 ||
      body.displays > 16
    ) {
      throw apiError('validation_failed', 'invalid heartbeat');
    }
    const nuclear = this.punishments.filter((p) => p.level === 'nuclear' && p.status === 'active');
    const active = this.nuclearActive();
    const ends = nuclear.map((p) => Date.parse(p.endsAt));
    return {
      nuclearActive: active,
      endsAt: active && ends.length > 0 ? iso(Math.max(...ends)) : null,
      serverNow: iso(this.clock.now()),
    };
  }

  async deleteData(body: DeleteDataRequest, options?: WriteOptions): Promise<DeleteDataResponse> {
    this.step();
    return this.idem('POST /v1/data/delete', options?.idempotencyKey, body, () => {
      this.writable();
      const word = typeof body?.confirm === 'string' ? body.confirm.trim().toUpperCase() : '';
      if (!DATA_DELETE_CONFIRM_WORDS.includes(word)) {
        throw apiError('confirm_word_mismatch', 'type BORRAR');
      }
      if (this.emergency) {
        throw apiError('data_delete_blocked', 'an emergency is pending', { reason: 'emergency_pending' });
      }
      const previousEpoch = this.epoch;
      const carry = Math.min(0, this.points.balance);
      const now = this.clock.now();
      this.epoch = this.newId('ep') as EpochId;
      this.seq = 0;
      this.events = [];
      this.close();
      this.idempotency.clear();
      this.ended = [];
      this.endedBlocks = [];
      const keptSchedules = this.schedules.filter((s) => s.activeBlockId !== null);
      this.schedules = keptSchedules;
      this.points = { ...defaultPoints(localDay(now, this.settings.timezone)), balance: carry };
      this.points.today.goalMinutes = this.settings.dailyGoalMinutes;
      this.settings = { ...this.settings, studyWhitelist: { extraDomains: [], extraProcesses: [] } };
      this.emit(
        'epoch_started',
        {
          reason: 'data_deleted',
          previousEpoch,
          carryOverBalance: carry,
          escalation: {
            lastCountedAt:
              this.escalation.lastCountedAtMs === null ? null : iso(this.escalation.lastCountedAtMs),
            index: this.escalation.index,
          },
          kept: {
            blocks: clone(this.blocks),
            punishments: clone(this.punishments),
            allowances: [],
            schedules: clone(keptSchedules),
            settings: clone(this.settings),
            pendingSettings: [],
            materializedOccurrences: [],
          },
        },
        { points: carry },
      );
      this.changed();
      return {
        epoch: this.epoch,
        carryOverBalance: carry,
        keptBlockIds: this.blocks.map((b) => b.id),
        keptPunishmentIds: this.punishments.map((p) => p.id),
        keptScheduleIds: keptSchedules.map((s) => s.id),
      };
    });
  }
}

function isEligibleMode(mode: BlockMode): boolean {
  return mode === 'normal' || mode === 'strict';
}

/** Punishment blocks count as strict for the countdown. */
function effectiveMode(block: Block): BlockMode {
  return block.kind === 'punishment' ? 'strict' : block.mode;
}

function scheduleFields(body: ScheduleInput): Omit<
  Schedule,
  'id' | 'createdAt' | 'updatedAt' | 'nextOccurrence' | 'activeBlockId'
> {
  return {
    name: body.name,
    enabled: body.enabled,
    days: [...body.days],
    start: body.start,
    end: body.end,
    timezone: body.timezone,
    targets: clone(body.targets),
    whitelistOnly: body.whitelistOnly,
    allow: body.whitelistOnly ? clone(body.allow) : emptyAllow(),
    mode: body.mode,
    reason: body.reason,
  };
}
