/**
 * Daily limits of the `MockGuardian` (ARCHITECTURE §5.10, §8.8 «Daily limits», «Usage»,
 * §10.13), so the dev mock and the harness's fake guardian behave like the real one:
 *
 * - `POST`/`PUT`/`DELETE /v1/limits`: stricter parts apply at once, the rest waits 24 h as
 *   `pendingChange` (`splitLimitChange`, `pendingLimitDelayKept`), a deletion always waits;
 * - `POST /v1/usage`: the app's `process` items (a `domain` item is 403 like the real one), the
 *   per-client clamp (`clampUsageInterval`) and the per-limit credited spans (`limitUsageCredit`);
 * - the time step: the local day rolls over (`limit_day_closed`), pending changes apply from
 *   the next day at the earliest, and `evaluateLimits` writes `limit_warning` 5 min before
 *   the end and `limit_reached` + a `limit` block until the next local midnight when the
 *   allowance runs out (once per limit and day, plus a strengthening edit's extra block).
 *
 * Nothing here ever ends a block: limit blocks are ordinary blocks of the host once made.
 * The pending delay counts wall time on the mock clock (the real guardian counts running or
 * verified time; the mock has no downtime).
 */
import {
  getApp,
  getService,
  isSameOrSubdomain,
  processNameKey,
  resolveTargets,
  type CatalogPlatform,
  type ResolvedTargets,
} from '@centrate/shared/catalog';
import type {
  Block,
  DailyLimit,
  DailyLimitDefinition,
  EventDataMap,
  EventType,
  LimitId,
  TargetSpec,
} from '@centrate/shared/domain';
import {
  GUARDIAN_ERROR_STATUS,
  GUARDIAN_LIMITS,
  GuardianApiError,
  clampUsageInterval,
  isDailyLimitInput,
  isUsageReportRequest,
  limitModeRank,
  limitUsageCredit,
  pendingLimitDelayKept,
  splitLimitChange,
  type CreditSpan,
  type DailyLimitInput,
  type GuardianErrorCode,
  type LimitUsageStatus,
  type UsageItem,
  type UsageReportRequest,
  type UsageReportResponse,
} from '@centrate/shared/guardian-api';
import {
  dateKey,
  isoWeekday,
  localDateOf,
  nextLocalMidnight,
  startOfLocalDay,
} from './mock-schedules';

const MIN = 60_000;

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

/** What the mock needs from its guardian (clock, ids, events, blocks). */
export interface LimitHost {
  now(): number;
  /** `settings.timezone`. */
  timeZone(): string;
  newId(prefix: string): string;
  platform: CatalogPlatform;
  emit<K extends EventType>(type: K, data: EventDataMap[K], options?: { txEnd?: boolean }): void;
  /** A `limit` block for `limit`, not added yet (its id goes into `limit_reached`). */
  makeLimitBlock(limit: DailyLimit, startsAt: number, endsAt: number): Block;
  /** Adds it (`block_created{source: "limit"}`, allowance revocations when hardcore). */
  addLimitBlock(block: Block): void;
  /** Today's active limit block of `limitId` (the latest-ending one). */
  activeLimitBlock(limitId: LimitId): Block | null;
}

interface Covered {
  targets: TargetSpec;
  rank: number;
}

interface LimitRecord {
  id: LimitId;
  createdAt: number;
  updatedAt: number;
  def: DailyLimitDefinition;
  resolved: ResolvedTargets;
  pending: { definition: DailyLimitDefinition | null; effectiveAt: number } | null;
  usage: {
    day: string;
    usedMs: number;
    creditedUntil: number;
    credited: CreditSpan[];
    warnedAt: number;
    reachedAt: number;
    covered: Covered | null;
    blocksToday: number;
  };
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

function definitionOf(input: DailyLimitDefinition): DailyLimitDefinition {
  return {
    name: input.name,
    enabled: input.enabled,
    targets: cloneTargets(input.targets),
    dailyMinutes: input.dailyMinutes,
    days: [...new Set(input.days)].sort((a, b) => a - b),
    mode: input.mode,
    reason: input.reason,
  };
}

const TARGET_LISTS = [
  'serviceIds',
  'categoryIds',
  'appIds',
  'customDomains',
  'customProcesses',
] as const;

function containsTargets(outer: TargetSpec, inner: TargetSpec): boolean {
  return TARGET_LISTS.every((list) =>
    (inner[list] as readonly string[]).every((x) => (outer[list] as readonly string[]).includes(x)),
  );
}

function unionTargets(a: TargetSpec, b: TargetSpec): TargetSpec {
  const union = <T extends string>(x: readonly T[], y: readonly T[]): T[] => [
    ...new Set([...x, ...y]),
  ];
  return {
    serviceIds: union(a.serviceIds, b.serviceIds),
    categoryIds: union(a.categoryIds, b.categoryIds),
    appIds: union(a.appIds, b.appIds),
    customDomains: union(a.customDomains, b.customDomains),
    customProcesses: union(a.customProcesses, b.customProcesses),
  };
}

function sameDefinition(a: DailyLimitDefinition | null, b: DailyLimitDefinition | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a usage item counts for a limit's resolved targets. */
export function usageItemMatches(
  resolved: ResolvedTargets,
  item: UsageItem,
  platform: CatalogPlatform,
): boolean {
  if (item.type === 'process') {
    const key = processNameKey(item.value, platform);
    return resolved.processes.some((p) => processNameKey(p, platform) === key);
  }
  const host = item.value.toLowerCase();
  if (resolved.excludedDomains.some((d) => isSameOrSubdomain(host, d))) return false;
  return resolved.domains.some((d) => isSameOrSubdomain(host, d));
}

function resolveLimit(def: DailyLimitDefinition, platform: CatalogPlatform): ResolvedTargets {
  return resolveTargets(
    {
      serviceIds: def.targets.serviceIds,
      categoryIds: def.targets.categoryIds,
      appIds: def.targets.appIds,
      domains: def.targets.customDomains,
      processNames: def.targets.customProcesses,
    },
    platform,
  );
}

export class MockLimits {
  private records: LimitRecord[] = [];
  /** Boot-clock time of each client's last accepted report (in memory, like the guardian). */
  private readonly lastUsage = new Map<string, number>();

  constructor(
    private readonly host: LimitHost,
    seed: readonly DailyLimit[] = [],
  ) {
    const now = host.now();
    const today = this.today(now);
    for (const limit of seed) {
      const def = definitionOf(limit);
      const reached = limit.reachedAt ? Date.parse(limit.reachedAt) : 0;
      this.records.push({
        id: limit.id,
        createdAt: Date.parse(limit.createdAt),
        updatedAt: Date.parse(limit.updatedAt),
        def,
        resolved: resolveLimit(def, host.platform),
        pending: limit.pendingChange
          ? {
              definition: limit.pendingChange.definition
                ? definitionOf(limit.pendingChange.definition)
                : null,
              effectiveAt: Date.parse(limit.pendingChange.effectiveAt),
            }
          : null,
        usage: {
          day: limit.day === today ? limit.day : today,
          usedMs: limit.day === today ? limit.usedTodaySeconds * 1_000 : 0,
          creditedUntil: 0,
          credited: [],
          warnedAt:
            limit.day === today &&
            limit.remainingTodaySeconds <= GUARDIAN_LIMITS.limitWarningSeconds
              ? now
              : 0,
          reachedAt: limit.day === today ? reached : 0,
          covered:
            limit.day === today && reached > 0
              ? { targets: cloneTargets(def.targets), rank: limitModeRank(def.mode) }
              : null,
          blocksToday: limit.day === today && limit.activeBlockId ? 1 : 0,
        },
      });
    }
  }

  private today(now: number): string {
    return dateKey(localDateOf(now, this.host.timeZone()));
  }

  private appliesToday(def: DailyLimitDefinition, now: number): boolean {
    return def.enabled && def.days.includes(isoWeekday(localDateOf(now, this.host.timeZone())));
  }

  private view(rec: LimitRecord, now: number, exact: boolean): DailyLimit {
    const seconds = Math.floor(rec.usage.usedMs / 1_000);
    const used = exact ? seconds : Math.floor(seconds / 60) * 60;
    const applies = this.appliesToday(rec.def, now);
    return {
      ...clone(rec.def),
      id: rec.id,
      createdAt: iso(rec.createdAt),
      updatedAt: iso(rec.updatedAt),
      day: rec.usage.day,
      appliesToday: applies,
      usedTodaySeconds: used,
      remainingTodaySeconds: Math.max(0, rec.def.dailyMinutes * 60 - used),
      reachedAt: applies && rec.usage.reachedAt > 0 ? iso(rec.usage.reachedAt) : null,
      activeBlockId: this.host.activeLimitBlock(rec.id)?.id ?? null,
      pendingChange: rec.pending
        ? {
            definition: rec.pending.definition ? clone(rec.pending.definition) : null,
            effectiveAt: iso(rec.pending.effectiveAt),
          }
        : null,
    };
  }

  /** `GET /v1/limits`: exact seconds. */
  list(): DailyLimit[] {
    const now = this.host.now();
    return this.records.map((r) => this.view(r, now, true));
  }

  /** `/v1/state.limits`: usage floored to whole minutes. */
  stateList(): DailyLimit[] {
    const now = this.host.now();
    return this.records.map((r) => this.view(r, now, false));
  }

  /** Every limit as data deletion keeps it (`kept.limits`). */
  keptIds(): LimitId[] {
    return this.records.map((r) => r.id);
  }

  /** Today's minutes of every limit, for «did the floored state change?». */
  private minuteMarks(): string {
    return this.records.map((r) => `${r.id}:${Math.floor(r.usage.usedMs / MIN)}`).join(',');
  }

  private validate(body: DailyLimitInput): void {
    if (!isDailyLimitInput(body)) {
      throw apiError('validation_failed', 'invalid limit', { path: '$', issue: 'shape' });
    }
    body.targets.serviceIds.forEach((id, i) => {
      if (!getService(id)) {
        throw apiError('unknown_id', 'unknown service', { path: `targets.serviceIds.${i}`, id });
      }
    });
    body.targets.appIds.forEach((id, i) => {
      if (!getApp(id)) {
        throw apiError('unknown_id', 'unknown app', { path: `targets.appIds.${i}`, id });
      }
    });
  }

  private requireAck(def: DailyLimitDefinition, body: DailyLimitInput): void {
    if (def.mode === 'hardcore' && !body.acknowledgeNoEmergency) {
      throw apiError('confirmation_required', 'confirmation required', {
        needs: ['no_emergency'],
      });
    }
  }

  /** `effectiveAt` of a new pending change: 24 h, and never on the day it was requested. */
  private pendingDue(now: number): number {
    const tomorrow = nextLocalMidnight(now, this.host.timeZone());
    return Math.max(now + GUARDIAN_LIMITS.limitWeakeningDelayMs, tomorrow);
  }

  create(body: DailyLimitInput): DailyLimit {
    this.validate(body);
    if (this.records.length >= GUARDIAN_LIMITS.maxLimits) {
      throw apiError('validation_failed', 'too many limits', {
        path: '$',
        issue: 'length',
        limit: GUARDIAN_LIMITS.maxLimits,
      });
    }
    const def = definitionOf(body);
    this.requireAck(def, body);
    const now = this.host.now();
    const rec: LimitRecord = {
      id: this.host.newId('lim') as LimitId,
      createdAt: now,
      updatedAt: now,
      def,
      resolved: resolveLimit(def, this.host.platform),
      pending: null,
      usage: {
        day: this.today(now),
        usedMs: 0,
        creditedUntil: 0,
        credited: [],
        warnedAt: 0,
        reachedAt: 0,
        covered: null,
        blocksToday: 0,
      },
    };
    this.records.push(rec);
    this.host.emit('limit_created', { limit: this.view(rec, now, true) });
    this.evaluate(now);
    return this.view(rec, this.host.now(), true);
  }

  update(id: LimitId, body: DailyLimitInput): { limit: DailyLimit; changed: boolean } {
    this.validate(body);
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw apiError('not_found', 'no such limit');
    const requested = definitionOf(body);
    const { applied, pending } = splitLimitChange(rec.def, requested);
    this.requireAck(requested, body);
    const now = this.host.now();
    const samePending = sameDefinition(rec.pending ? rec.pending.definition : null, pending);
    const noPendingBefore = rec.pending === null;
    const unchanged =
      sameDefinition(rec.def, applied) &&
      ((pending === null && noPendingBefore) || (!noPendingBefore && samePending));
    if (unchanged) return { limit: this.view(rec, now, true), changed: false };
    const grew = !containsTargets(rec.def.targets, applied.targets);
    rec.def = applied;
    if (grew) rec.resolved = resolveLimit(applied, this.host.platform);
    if (pending === null) {
      rec.pending = null;
    } else if (rec.pending && pendingLimitDelayKept(rec.pending.definition, pending)) {
      rec.pending = { definition: pending, effectiveAt: rec.pending.effectiveAt };
    } else {
      rec.pending = { definition: pending, effectiveAt: this.pendingDue(now) };
    }
    rec.updatedAt = now;
    this.host.emit('limit_updated', { limit: this.view(rec, now, true), cause: 'user' });
    this.evaluate(now);
    return { limit: this.view(rec, this.host.now(), true), changed: true };
  }

  remove(id: LimitId): { limit: DailyLimit; changed: boolean } {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw apiError('not_found', 'no such limit');
    const now = this.host.now();
    if (rec.pending && rec.pending.definition === null) {
      return { limit: this.view(rec, now, true), changed: false };
    }
    rec.pending = { definition: null, effectiveAt: this.pendingDue(now) };
    rec.updatedAt = now;
    this.host.emit('limit_updated', { limit: this.view(rec, now, true), cause: 'user' });
    return { limit: this.view(rec, now, true), changed: true };
  }

  /** `POST /v1/usage` from `client` (`app`: process items only). */
  report(
    client: 'app',
    body: UsageReportRequest,
  ): { response: UsageReportResponse; changed: boolean } {
    if (!isUsageReportRequest(body)) {
      throw apiError('validation_failed', 'invalid usage report', { path: '$', issue: 'rule' });
    }
    if (body.items.some((item) => item.type !== 'process')) {
      throw apiError('insufficient_scope', 'the app reports processes only');
    }
    const now = this.host.now();
    const before = this.minuteMarks();
    const last = this.lastUsage.get(client);
    const interval = clampUsageInterval(body.intervalMs, last === undefined ? null : now - last);
    this.lastUsage.set(client, now);
    const dayStart = startOfLocalDay(now, this.host.timeZone());
    const credited = new Map<string, number>();
    for (const rec of this.records) {
      if (!rec.def.enabled) continue;
      let reported = 0;
      for (const item of body.items) {
        if (usageItemMatches(rec.resolved, item, this.host.platform))
          reported += item.seconds * 1_000;
      }
      reported = Math.min(reported, interval);
      const c = limitUsageCredit({
        nowMs: now,
        dayStartMs: dayStart,
        intervalMs: interval,
        reportedMs: reported,
        creditedUntilMs: rec.usage.creditedUntil,
        credited: rec.usage.credited,
      });
      rec.usage.usedMs += c.creditMs;
      rec.usage.credited = c.credited;
      credited.set(rec.id, Math.floor(c.creditMs / 1_000));
    }
    const events = this.evaluate(now);
    const limits: LimitUsageStatus[] = this.records
      .filter((r) => r.def.enabled)
      .map((rec) => {
        const v = this.view(rec, now, true);
        const block = this.host.activeLimitBlock(rec.id);
        return {
          limitId: rec.id,
          usedTodaySeconds: v.usedTodaySeconds,
          remainingTodaySeconds: v.remainingTodaySeconds,
          appliesToday: v.appliesToday,
          creditedSeconds: Math.min(
            credited.get(rec.id) ?? 0,
            GUARDIAN_LIMITS.usageMaxIntervalMs / 1_000,
          ),
          blockedUntil: block ? block.endsAt : null,
        };
      });
    return {
      response: { day: this.today(now), limits, serverNow: iso(now) },
      changed: events || before !== this.minuteMarks(),
    };
  }

  /**
   * The time step: day rollover, due pending changes, then `evaluateLimits`. `true` when
   * something visible changed (events written).
   */
  step(): boolean {
    const now = this.host.now();
    const today = this.today(now);
    let dirty = false;
    for (const rec of this.records) {
      if (rec.usage.day === today) continue;
      this.closeDay(rec);
      rec.usage = {
        day: today,
        usedMs: 0,
        creditedUntil: rec.usage.creditedUntil,
        credited: rec.usage.credited,
        warnedAt: 0,
        reachedAt: 0,
        covered: null,
        blocksToday: 0,
      };
      dirty = true;
    }
    for (const rec of [...this.records]) {
      if (!rec.pending || rec.pending.effectiveAt > now) continue;
      const next = rec.pending.definition;
      rec.pending = null;
      rec.updatedAt = now;
      dirty = true;
      if (next === null) {
        // The day so far still reaches the statistics (limit_days).
        this.closeDay(rec);
        this.records = this.records.filter((r) => r.id !== rec.id);
        this.host.emit('limit_deleted', { limitId: rec.id, name: rec.def.name });
        continue;
      }
      rec.def = next;
      rec.resolved = resolveLimit(next, this.host.platform);
      this.host.emit('limit_updated', {
        limit: this.view(rec, now, true),
        cause: 'pending_applied',
      });
    }
    if (this.evaluate(now)) dirty = true;
    return dirty;
  }

  /** `limit_day_closed` for the record's day when it had usage or was reached. */
  private closeDay(rec: LimitRecord): void {
    if (rec.usage.usedMs <= 0 && rec.usage.reachedAt <= 0) return;
    const day = rec.usage.day;
    const [y, m, d] = day.split('-').map(Number);
    const weekday = isoWeekday({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 });
    this.host.emit('limit_day_closed', {
      limitId: rec.id,
      name: rec.def.name,
      day,
      dailyMinutes: rec.def.dailyMinutes,
      usedSeconds: Math.floor(rec.usage.usedMs / 1_000),
      applied: rec.def.enabled && rec.def.days.includes(weekday),
      reached: rec.usage.reachedAt > 0,
    });
  }

  /** `evaluateLimits(T)` (§10.13). `true` when it wrote events. */
  private evaluate(now: number): boolean {
    let wrote = false;
    for (const rec of this.records) {
      const def = rec.def;
      if (!this.appliesToday(def, now)) continue;
      const allowance = def.dailyMinutes * MIN;
      const used = rec.usage.usedMs;
      if (used < allowance) {
        if (
          allowance - used <= GUARDIAN_LIMITS.limitWarningSeconds * 1_000 &&
          rec.usage.warnedAt === 0
        ) {
          const usedSeconds = Math.floor(used / 1_000);
          this.host.emit('limit_warning', {
            limitId: rec.id,
            name: def.name,
            day: rec.usage.day,
            dailyMinutes: def.dailyMinutes,
            usedSeconds,
            remainingSeconds: Math.max(1, def.dailyMinutes * 60 - usedSeconds),
          });
          rec.usage.warnedAt = now;
          wrote = true;
        }
        continue;
      }
      const end = nextLocalMidnight(now, this.host.timeZone());
      const first = rec.usage.reachedAt === 0;
      const covered = rec.usage.covered;
      const grow =
        !first &&
        (covered === null ||
          !containsTargets(covered.targets, def.targets) ||
          limitModeRank(def.mode) > covered.rank);
      if (!first && (!grow || rec.usage.blocksToday >= GUARDIAN_LIMITS.limitMaxBlocksPerDay)) {
        continue;
      }
      const view = this.view(rec, now, true);
      const block =
        end - now >= GUARDIAN_LIMITS.limitMinBlockMs
          ? this.host.makeLimitBlock(view, now, end)
          : null;
      if (block) rec.usage.blocksToday += 1;
      if (first) {
        rec.usage.reachedAt = now;
        this.host.emit(
          'limit_reached',
          {
            limitId: rec.id,
            name: def.name,
            day: rec.usage.day,
            dailyMinutes: def.dailyMinutes,
            usedSeconds: Math.floor(used / 1_000),
            blockId: block ? block.id : null,
          },
          { txEnd: block === null },
        );
      }
      if (block) this.host.addLimitBlock(block);
      rec.usage.covered = {
        targets: covered ? unionTargets(covered.targets, def.targets) : cloneTargets(def.targets),
        rank: Math.max(covered?.rank ?? 0, limitModeRank(def.mode)),
      };
      wrote = true;
    }
    return wrote;
  }
}
