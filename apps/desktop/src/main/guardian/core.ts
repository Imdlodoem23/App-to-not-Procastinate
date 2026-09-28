/**
 * `createCore` (docs/DESKTOP.md §3.1, §6): the app's state and guardian I/O in the main
 * process. It owns the `UiSnapshot` store and every timer that matters: the state poller,
 * the event sync (local statistics DB + notifications), the «Bloqueando…» create, the 5 s
 * extend queue, the five-minute notices, and the commands behind every invoke channel. No
 * window code here: MAIN-WINDOW implements `CoreHost` and pushes snapshots to renderers.
 *
 * Guardian source, in order:
 * 1. harness fixture (`options.harness`): `FakeGuardianClient` seeded from it on a frozen
 *    clock (`options.clock` is not used), no disk writes, an in-memory DB;
 * 2. `CENTRATE_MOCK_GUARDIAN=1` on an unpackaged app: the in-memory `MockGuardian` on the
 *    real clock (dev without the Go guardian);
 * 3. the real guardian: HTTP on 127.0.0.1 with Node's fetch and the token from
 *    `<sys>/client.json`.
 *
 * Every handler resolves to a `CommandResult` (or its channel's value) and never throws.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import type { BlockId, EmergencyId, Schedule, ScheduleId } from '@centrate/shared/domain';
import { isIdOf } from '@centrate/shared/domain';
import {
  DATA_DELETE_CONFIRM_WORDS,
  GUARDIAN_LIMITS,
  type GuardianClient,
  type GuardianStateResponse,
  type ScheduleInput,
} from '@centrate/shared/guardian-api';
import type { HarnessFixture } from '../../shared/fixtures';
import { PHASE5_INVOKE_GUARDS } from '../../shared/ipc-payloads';
import type { InstallOutcome } from '../../shared/platform';
import { phase5InvokeStubs } from '../../shared/phase5-stubs';
import {
  UI_TIMINGS,
  fail,
  initialSnapshot,
  isIntentId,
  ok,
  snapshotFeature,
  toUiError,
  uiError,
  type CommandResult,
  type PlatformSnapshotPatch,
  type UiSnapshot,
} from '../../shared/ui-state';
import { ActiveWindowLayer, createForegroundReader } from '../activewin';
import type { Clock, Core, CoreHarness, CoreOptions, RefreshReason } from '../contracts';
import { createNullEventsDb, openEventsDb, type EventsDb } from '../db/events-db';
import { eventsDbFileName } from '../db/stats';
import { ReminderScheduler } from '../reminders';
import {
  applyPrefsPatch,
  defaultTemplates,
  isUiPrefsPatch,
  prefsPath,
  readStoredPrefs,
  upsertTemplate,
  writeStoredPrefs,
} from '../db/prefs-store';
import { appLog, initAppLog, type AppLogger } from '../logs/logger';
import { createElectronNotifier } from '../notifications/notifier';
import { NotificationScheduler } from '../notifications/scheduler';
import type { Notifier } from '../notifications/types';
import { createRecordingNotifier } from '../notifications/types';
import { buildDiagnostics, type DiagnosticsDeps } from '../system/diagnostics';
import { runFile, type ExecRunner } from '../system/exec';
import { DIAGNOSTICS } from '../system/i18n';
import { GuardianInstaller } from '../system/installer';
import { listProcessNames } from '../system/processes';
import { withTimeout, createPortAwareClient } from './client';
import {
  clientJsonPath,
  createClientJsonSource,
  staticTokenSource,
  type TokenSource,
} from './client-json';
import { createManualClock, type ManualClock } from './clock';
import { CreateOperation } from './create';
import { EventSync } from './event-sync';
import { ExtendQueue } from './extend-queue';
import { createFakeGuardian, type FakeGuardian } from './fake-guardian';
import { MockGuardian, mockGuardianEnabled } from './mock';
import { NuclearHeartbeat } from './nuclear-heartbeat';
import { Poller, VersionFloor } from './poller';
import { createSnapshotStore, type SnapshotStore } from './store';

/** Test and wiring overrides (production passes none). */
export interface CoreInternals {
  notifier?: Notifier;
  exec?: ExecRunner;
  logger?: AppLogger;
  env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the real HTTP guardian (tests). */
  guardian?: { client: GuardianClient; tokenSource: TokenSource };
  /** `:memory:` in tests. */
  eventsDbPath?: string;
  /** Skip writing prefs.json (tests). */
  persistPrefs?: boolean;
  runtime?: DiagnosticsDeps['runtime'];
}

type Mode = 'real' | 'mock' | 'harness';

interface Session {
  clock: Clock;
  manual: ManualClock | null;
  client: GuardianClient;
  tokenSource: TokenSource;
  fake: FakeGuardian | null;
  mock: MockGuardian | null;
  db: EventsDb;
  ownsDb: boolean;
  floor: VersionFloor;
  poller: Poller;
  events: EventSync;
  create: CreateOperation;
  extend: ExtendQueue;
  notifications: NotificationScheduler;
  timers: Set<ReturnType<typeof setTimeout>>;
}

/** Retry refreshes after a successful «Reparar» (the service needs a moment to listen). */
const AFTER_REPAIR_REFRESH_MS: readonly number[] = [1_000, 3_000, 8_000];

function harnessSnapshot(fixture: HarnessFixture): UiSnapshot {
  return {
    ...structuredClone(fixture.snapshot),
    harness: { stateId: fixture.id, frozenNowMs: fixture.nowMs },
  };
}

export function createCore(options: CoreOptions, internals: CoreInternals = {}): Core {
  const env = internals.env ?? process.env;
  const exec = internals.exec ?? runFile;
  const mode: Mode = options.harness
    ? 'harness'
    : internals.guardian
      ? 'real'
      : mockGuardianEnabled(env, options.packaged)
        ? 'mock'
        : 'real';
  // The shell may have opened the shared app log already (same file): reuse it.
  const log =
    internals.logger ??
    (appLog().file !== null
      ? appLog()
      : initAppLog(options.userDataDir, { echo: !options.packaged }));
  const persist = internals.persistPrefs ?? mode !== 'harness';
  const prefsFile = prefsPath(options.userDataDir);

  const stored = options.harness ? null : readStoredPrefs(prefsFile);
  const store: SnapshotStore = createSnapshotStore(
    options.harness
      ? harnessSnapshot(options.harness)
      : initialSnapshot(
          {
            version: options.appVersion,
            platform: options.platform,
            packaged: options.packaged,
            updateVersion: null,
            systemLocale: options.systemLocale ?? 'es',
          },
          options.clock.now(),
          stored?.prefs,
          stored?.templates,
          options.features,
        ),
  );

  const notifier: Notifier =
    internals.notifier ??
    (mode === 'harness'
      ? createRecordingNotifier()
      : createElectronNotifier({ onClick: () => options.host.showMain('notification') }));

  const installer = new GuardianInstaller({
    platform: options.platform,
    packaged: options.packaged,
    binary: options.guardianBinary,
    env,
    exec,
    log: (event, fields) => log.info(event, fields),
  });

  const runtime: DiagnosticsDeps['runtime'] = internals.runtime ?? {
    os: `${options.platform} ${release()}`,
    arch: arch(),
    electron: process.versions['electron'] ?? null,
    node: process.versions.node,
  };

  let started = false;
  let stopped = false;
  let currentFixture: HarnessFixture | null = options.harness;
  let realDb: EventsDb | null = null;

  function openDb(path: string): EventsDb {
    try {
      return openEventsDb(path, {
        onRecreated: (error) =>
          log.warn('events_db_recreated', {
            error: error instanceof Error ? error.name : 'unknown',
          }),
      });
    } catch (error) {
      log.error('events_db_unavailable', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      try {
        return openEventsDb(':memory:');
      } catch {
        return createNullEventsDb();
      }
    }
  }

  function persistPrefs(): void {
    if (!persist) return;
    const s = store.get();
    try {
      writeStoredPrefs(prefsFile, { prefs: s.prefs, templates: s.templates });
    } catch (error) {
      log.error('prefs_write_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  function buildSession(fixture: HarnessFixture | null): Session {
    let clock: Clock = options.clock;
    let manual: ManualClock | null = null;
    let client: GuardianClient;
    let tokenSource: TokenSource;
    let fake: FakeGuardian | null = null;
    let mock: MockGuardian | null = null;
    let db: EventsDb;
    let ownsDb = true;
    if (fixture) {
      manual = createManualClock(fixture.nowMs);
      clock = manual;
      fake = createFakeGuardian(fixture, clock);
      client = fake.client;
      tokenSource = fake.tokenSource;
      db = openDb(':memory:');
    } else if (mode === 'mock') {
      mock = new MockGuardian({ clock, emergencyUnitMs: 1_000 });
      client = mock;
      tokenSource = staticTokenSource({ missing: false });
      // Its own file, so statistics work in dev too (a new mock epoch wipes it on the first page).
      db = openDb(
        internals.eventsDbPath ?? join(options.userDataDir, eventsDbFileName(true)),
      );
    } else {
      if (internals.guardian) {
        client = internals.guardian.client;
        tokenSource = internals.guardian.tokenSource;
      } else {
        tokenSource = createClientJsonSource(clientJsonPath(options.sysDir, options.platform));
        client = createPortAwareClient(tokenSource);
      }
      realDb ??= openDb(
        internals.eventsDbPath ?? join(options.userDataDir, eventsDbFileName(false)),
      );
      db = realDb;
      ownsDb = false;
    }

    const floor = new VersionFloor({
      now: () => clock.now(),
      epoch: () => store.get().state?.epoch ?? null,
    });
    const tokenMissing = (): boolean => tokenSource.missing();
    const notifications = new NotificationScheduler({
      clock,
      notifier,
      mainFocused: () => {
        const v = options.host.visibility();
        return v.anyVisible && v.mainFocused;
      },
      getState: () => store.get().state,
    });
    // `poller` and `events` reference each other through callbacks: declared first.
    // eslint-disable-next-line prefer-const
    let events: EventSync;
    const extend: ExtendQueue = new ExtendQueue({
      clock,
      client,
      store,
      floor,
      newKey: () => randomUUID(),
      newEntryId: () => `extq_${randomUUID()}`,
      onExtended: () => {
        poller.refreshNow('write');
        events.kick();
      },
      onUnresponsive: () => poller.refreshNow('retry'),
      onRefused: (error) => {
        // e.g. `block_not_active`: the block ended, so the section should say so now.
        log.info('block_extend_refused', { code: error.code, status: error.status });
        poller.refreshNow('write');
      },
    });
    const poller: Poller = new Poller({
      clock,
      client,
      store,
      floor,
      tokenMissing,
      visible: () => options.host.visibility().anyVisible,
      onState: (state: GuardianStateResponse) => {
        extend.reconcile(state);
        notifications.onState(state);
      },
      onHealth: (health) => {
        if (mode === 'real') void installer.maybeUpgrade(health.version).then(afterElevation);
      },
      onLinkUp: () => events.kick(),
    });
    events = new EventSync({
      clock,
      client,
      db,
      onPage: (page, info) => {
        notifications.ingestEvents(page.events, info.notify);
        if (page.events.length > 0 || page.reset) poller.refreshNow('event');
      },
      onError: (stage, error) => {
        const e = toUiError(error);
        log.debug('event_sync_error', { stage, code: e.code, status: e.status });
      },
    });
    const create = new CreateOperation({
      clock,
      client,
      store,
      floor,
      tokenMissing,
      onCreated: (block) => {
        log.info('block_created', { mode: block.mode, kind: block.kind });
        persistPrefs();
        poller.refreshNow('write');
        events.kick();
      },
      onUnresponsive: () => poller.refreshNow('retry'),
    });
    return {
      clock,
      manual,
      client,
      tokenSource,
      fake,
      mock,
      db,
      ownsDb,
      floor,
      poller,
      events,
      create,
      extend,
      notifications,
      timers: new Set(),
    };
  }

  let session = buildSession(options.harness);
  if (options.harness) session.poller.setEtag(session.fake?.initialEtag() ?? null);

  function startSession(s: Session): void {
    s.notifications.onState(store.get().state);
    s.extend.adopt();
    s.create.adoptPending();
    s.poller.start();
    s.events.start();
  }

  function disposeSession(s: Session): void {
    s.poller.stop();
    s.events.stop();
    s.extend.stop();
    s.notifications.stop();
    s.fake?.dispose();
    s.mock?.close();
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    if (s.ownsDb) s.db.close();
  }

  function afterElevation(outcome: string | null): void {
    if (outcome !== 'started' || stopped) return;
    const s = session;
    for (const ms of AFTER_REPAIR_REFRESH_MS) {
      const t = setTimeout(() => {
        s.timers.delete(t);
        if (session === s && !stopped) s.poller.refreshNow('retry');
      }, ms);
      s.timers.add(t);
    }
  }

  // Link transitions go to the log (codes only); first-launch install on macOS / AppImage.
  let lastLink = `${store.get().link.status}:${store.get().link.reason ?? ''}`;
  store.subscribe((s) => {
    const link = `${s.link.status}:${s.link.reason ?? ''}`;
    if (link !== lastLink) {
      lastLink = link;
      log.info('guardian_link', { status: s.link.status, reason: s.link.reason });
      if (mode === 'real' && s.link.status === 'down' && s.link.reason === 'not_installed') {
        void installer.maybeAutoInstall().then(afterElevation);
      }
    }
  });

  // Phase 5 (docs/DESKTOP.md §15): the platform loops that talk to the guardian live here, next
  // to its client. Harness runs keep the fixture's own platform state (frozen clock).
  const live = mode !== 'harness';

  /** `Core.patchSnapshot`: a new `rev` only when something changed. */
  function patchSnapshot(patch: PlatformSnapshotPatch): void {
    store.update((s) => {
      const changed = (Object.keys(patch) as (keyof PlatformSnapshotPatch)[]).some(
        (key) => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(s[key]),
      );
      return changed ? { ...s, ...patch } : s;
    });
  }

  const activeWindow = live
    ? new ActiveWindowLayer({
        platform: options.platform,
        clock: options.clock,
        reader: createForegroundReader({ platform: options.platform, env, exec }),
        report: (serviceId, browser) =>
          call((c) =>
            c.reportAttempt({
              layer: 'window',
              target: { type: 'service', value: serviceId },
              browser,
              incognito: false,
            }),
          ).then((r) => {
            if (r.counted) {
              session.poller.refreshNow('write');
              session.events.kick();
            }
            return r;
          }),
        publish: (status) => patchSnapshot({ activeWindow: status }),
        log: (event, fields) => log.debug(event, fields),
      })
    : null;
  const reminders = live
    ? new ReminderScheduler({ clock: options.clock, show: (content) => notifier.show(content) })
    : null;
  const nuclearBeat = live
    ? new NuclearHeartbeat({
        clock: options.clock,
        send: (body) => call((c) => c.nuclearHeartbeat(body)),
        onBeat: (at) =>
          store.update((s) => ({ ...s, nuclear: { ...s.nuclear, lastHeartbeatAt: at } })),
        onInactive: () => session.poller.refreshNow('retry'),
        log: (event, fields) => log.warn(event, fields),
      })
    : null;

  function syncPlatform(s: UiSnapshot): void {
    if (!started || stopped) return;
    activeWindow?.sync(s.state, s.link.status === 'ok');
    reminders?.sync(s.state, s.prefs.reminders, snapshotFeature(s, 'reminders'));
    nuclearBeat?.sync(s);
  }
  store.subscribe(syncPlatform);

  /** Guardian call on the session clock with the 3 s rule. */
  function call<T>(run: (client: GuardianClient) => Promise<T>): Promise<T> {
    return withTimeout(run(session.client), session.clock, UI_TIMINGS.requestTimeoutMs);
  }

  /** Runs a fallible command: any exception becomes a `CommandResult` failure. */
  async function guarded<T>(run: () => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
    try {
      return await run();
    } catch (error) {
      const e = toUiError(error, { clientJsonMissing: session.tokenSource.missing() });
      log.info('command_failed', { kind: e.kind, code: e.code, status: e.status });
      return fail(e);
    }
  }

  /**
   * After a write whose response carries no `stateVersion` (emergency): any state at or
   * below the current version predates it, so a poll that raced the write is dropped.
   */
  function raiseFloorPastCurrent(): void {
    session.floor.raise((store.get().state?.stateVersion ?? 0) + 1);
  }

  function afterWrite(): void {
    session.poller.refreshNow('write');
    session.events.kick();
  }

  function patchState(fn: (state: GuardianStateResponse) => GuardianStateResponse): void {
    store.update((s) => (s.state ? { ...s, state: fn(s.state) } : s));
  }

  const isBlockIdList = (v: unknown): v is BlockId[] =>
    Array.isArray(v) &&
    v.length <= GUARDIAN_LIMITS.emergencyMaxBlocks &&
    v.every((id) => isIdOf('block', id));

  function scheduleInput(schedule: Schedule, enabled: boolean): ScheduleInput {
    return {
      name: schedule.name,
      enabled,
      days: [...schedule.days],
      start: schedule.start,
      end: schedule.end,
      timezone: schedule.timezone,
      targets: structuredClone(schedule.targets),
      whitelistOnly: schedule.whitelistOnly,
      allow: structuredClone(schedule.allow),
      mode: schedule.mode,
      reason: schedule.reason,
      acknowledgeNoEmergency: schedule.mode === 'hardcore' || schedule.mode === 'exam',
    };
  }

  const stubs = phase5InvokeStubs(
    () => (mode === 'harness' ? currentFixture : null),
    () => options.clock.now(),
  );
  const invalid = <T>(): CommandResult<T> => fail(uiError('rejected', 'validation_failed', 422));

  const handlers: Core['handlers'] = {
    // Phase 5 (docs/DESKTOP.md §15): fixture answers in harness mode, `not_implemented`
    // otherwise, until PLATFORM overrides each channel below this spread.
    ...stubs,

    'block:create': (req) =>
      session.create.create(req?.intentId, req?.request).then((r) => {
        if (!r.ok) log.info('block_create_failed', { kind: r.error.kind, code: r.error.code });
        return r;
      }),

    'block:create-retry': (req) => session.create.retry(req?.intentId),

    'block:extend': (req) => {
      try {
        return session.extend.extend(req?.blockId, req?.addMinutes);
      } catch (error) {
        return fail(toUiError(error));
      }
    },

    'block:extend-undo': (req) => {
      try {
        return session.extend.undo(req?.entryId);
      } catch {
        return 'too_late';
      }
    },

    'block:extend-retry': (req) => guarded(() => session.extend.retry(req?.entryId)),

    'emergency:preview': (req) =>
      guarded(async () => {
        const ids = req?.blockIds ?? null;
        if (ids !== null && !isBlockIdList(ids))
          return fail(uiError('rejected', 'validation_failed', 422));
        return ok(await call((c) => c.emergencyPreview(ids ?? undefined)));
      }),

    'emergency:request': (req) =>
      guarded(async () => {
        if (
          !isIntentId(req?.intentId) ||
          !isBlockIdList(req?.blockIds) ||
          typeof req?.phrase !== 'string' ||
          req.phrase.length > GUARDIAN_LIMITS.phraseMaxLength
        ) {
          return fail(uiError('rejected', 'validation_failed', 422));
        }
        const r = await call((c) =>
          c.requestEmergency(
            { blockIds: req.blockIds, phrase: req.phrase },
            { idempotencyKey: req.intentId },
          ),
        );
        raiseFloorPastCurrent();
        const covered = new Set<string>(r.emergency.blockIds);
        patchState((st) => ({
          ...st,
          emergency: r.emergency,
          rewardsLock: 'emergency',
          blocks: st.blocks.map((b) =>
            covered.has(b.id) ? { ...b, emergencyEligible: false } : b,
          ),
        }));
        log.info('emergency_requested', { blocks: r.emergency.blockIds.length });
        afterWrite();
        return ok(r.emergency);
      }),

    'emergency:cancel': (req) =>
      guarded(async () => {
        if (!isIdOf('emergency', req?.id))
          return fail(uiError('rejected', 'validation_failed', 422));
        const r = await call((c) => c.cancelEmergency(req.id as EmergencyId));
        raiseFloorPastCurrent();
        patchState((st) => ({ ...st, emergency: null }));
        log.info('emergency_cancelled', {});
        afterWrite();
        return ok(r.emergency);
      }),

    'emergency:confirm': (req) =>
      guarded(async () => {
        if (!isIntentId(req?.intentId) || !isIdOf('emergency', req?.id)) {
          return fail(uiError('rejected', 'validation_failed', 422));
        }
        const r = await call((c) =>
          c.confirmEmergency(
            req.id as EmergencyId,
            { acknowledge: true },
            { idempotencyKey: req.intentId },
          ),
        );
        raiseFloorPastCurrent();
        const gone = new Set<string>(r.cancelledBlockIds);
        patchState((st) => ({
          ...st,
          emergency: null,
          blocks: st.blocks.filter((b) => !gone.has(b.id)),
          punishments: st.punishments.filter((p) => !gone.has(p.blockId)),
        }));
        log.info('emergency_confirmed', {
          blocks: r.cancelledBlockIds.length,
          penalty: r.penaltyApplied,
        });
        afterWrite();
        return ok(r);
      }),

    'schedules:list': () =>
      guarded(async () => ok((await call((c) => c.listSchedules())).schedules)),

    'schedules:set-enabled': (req) =>
      guarded(async () => {
        if (!isIdOf('schedule', req?.id) || typeof req?.enabled !== 'boolean') {
          return fail(uiError('rejected', 'validation_failed', 422));
        }
        const { schedules } = await call((c) => c.listSchedules());
        const schedule = schedules.find((s) => s.id === req.id);
        if (!schedule) return fail(uiError('rejected', 'not_found', 404));
        const r = await call((c) =>
          c.updateSchedule(req.id as ScheduleId, scheduleInput(schedule, req.enabled)),
        );
        afterWrite();
        return ok(r.schedule);
      }),

    'templates:save': (req) =>
      guarded(async () => {
        const next = upsertTemplate(
          store.get().templates,
          req,
          () => `tpl_${randomUUID().replace(/-/g, '')}`,
        );
        if (!next) return fail(uiError('rejected', 'validation_failed', 422));
        store.update((s) => ({ ...s, templates: next }));
        persistPrefs();
        return ok(store.get().templates);
      }),

    'templates:delete': (req) =>
      guarded(async () => {
        const id = req?.id;
        const template = store.get().templates.find((t) => t.id === id);
        if (!template) return fail(uiError('rejected', 'not_found', 404));
        if (template.builtin) return fail(uiError('rejected', 'builtin_template', 409));
        store.update((s) => ({ ...s, templates: s.templates.filter((t) => t.id !== id) }));
        persistPrefs();
        return ok(store.get().templates);
      }),

    'prefs:set': (req) =>
      guarded(async () => {
        if (!isUiPrefsPatch(req)) return fail(uiError('rejected', 'validation_failed', 422));
        const next = applyPrefsPatch(store.get().prefs, req);
        store.update((s) =>
          JSON.stringify(s.prefs) === JSON.stringify(next) ? s : { ...s, prefs: next },
        );
        persistPrefs();
        return ok(store.get().prefs);
      }),

    'pairing:new-code': () =>
      guarded(async () => {
        const code = await call((c) => c.createPairingCode());
        log.info('pairing_code_created', { port: code.port });
        return ok(code);
      }),

    'diagnostics:copy': () =>
      guarded(async () => {
        const result = await buildDiagnostics({
          client: session.client,
          clock: session.clock,
          snapshot: store.get(),
          appLog: log,
          sysDir: options.sysDir,
          platform: options.platform,
          guardianStatus: () =>
            mode === 'real'
              ? installer.statusText()
              : Promise.resolve(DIAGNOSTICS.noRealGuardian(mode)),
          readText: (path) => {
            try {
              return readFileSync(path, 'utf8');
            } catch {
              return null;
            }
          },
          runtime,
        });
        options.host.writeClipboard(result.text);
        log.info('diagnostics_copied', { source: result.source });
        return ok({ source: result.source });
      }),

    'data:delete': (req) =>
      guarded(async () => {
        if (
          !isIntentId(req?.intentId) ||
          typeof req?.confirm !== 'string' ||
          req.confirm.length > 32
        ) {
          return fail(uiError('rejected', 'validation_failed', 422));
        }
        const word = req.confirm.trim().toUpperCase();
        if (!DATA_DELETE_CONFIRM_WORDS.includes(word)) {
          return fail(uiError('rejected', 'confirm_word_mismatch', 422));
        }
        const r = await call((c) =>
          c.deleteData({ confirm: req.confirm }, { idempotencyKey: req.intentId }),
        );
        try {
          session.db.wipe();
        } catch (error) {
          log.error('events_db_wipe_failed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
        store.update((s) => ({
          ...s,
          templates: defaultTemplates(),
          prefs: { ...s.prefs, lastReason: '' },
          ops: { ...s.ops, lastCreated: null },
        }));
        persistPrefs();
        log.info('data_deleted', { keptBlocks: r.keptBlockIds.length });
        afterWrite();
        return ok(r);
      }),

    'guardian:repair': () =>
      guarded(async () => {
        if (mode !== 'real') return ok({ outcome: 'unsupported' as const });
        const outcome = await installer.repair();
        afterElevation(outcome);
        if (outcome === 'failed') return fail(uiError('internal', 'repair_failed'));
        return ok({ outcome });
      }),

    'system:process-names': () =>
      guarded(async () => {
        if (mode === 'harness') return ok([...(currentFixture?.fake.processNames ?? [])]);
        return ok(await listProcessNames(options.platform, exec));
      }),

    // -------------------------------------------------------------------------------------
    // Phase 5, guardian-backed (docs/DESKTOP.md §15.3). Harness runs go through the fake
    // guardian seeded from `fixture.fake`. The local-data and OS channels (statistics,
    // achievements, processes, updater, sounds) are the platform services' (bootstrap).
    // -------------------------------------------------------------------------------------

    'schedules:create': (req) =>
      guarded(async () => {
        if (!PHASE5_INVOKE_GUARDS['schedules:create'](req)) return invalid();
        const r = await call((c) => c.createSchedule(req.input, { idempotencyKey: req.intentId }));
        log.info('schedule_created', { mode: r.schedule.mode });
        afterWrite();
        return ok(r.schedule);
      }),

    'schedules:update': (req) =>
      guarded(async () => {
        if (!PHASE5_INVOKE_GUARDS['schedules:update'](req)) return invalid();
        const r = await call((c) => c.updateSchedule(req.id, req.input));
        afterWrite();
        return ok(r.schedule);
      }),

    'schedules:delete': (req) =>
      guarded(async () => {
        if (!PHASE5_INVOKE_GUARDS['schedules:delete'](req)) return invalid();
        await call((c) => c.deleteSchedule(req.id));
        afterWrite();
        return ok(null);
      }),

    'settings:get': () => guarded(async () => ok(await call((c) => c.getSettings()))),

    'settings:put': (req) =>
      guarded(async () => {
        if (!PHASE5_INVOKE_GUARDS['settings:put'](req)) return invalid();
        const r = await call((c) => c.updateSettings(req.settings));
        log.info('settings_put', { pending: r.pending.length });
        afterWrite();
        return ok(r);
      }),

    'rewards:list': () => guarded(async () => ok(await call((c) => c.listRewards()))),

    'rewards:redeem': (req) =>
      guarded(async () => {
        if (!PHASE5_INVOKE_GUARDS['rewards:redeem'](req)) return invalid();
        const r = await call((c) =>
          c.redeemReward({ offerId: req.offerId }, { idempotencyKey: req.intentId }),
        );
        raiseFloorPastCurrent();
        patchState((st) => ({
          ...st,
          points: { ...st.points, balance: r.balanceAfter },
          allowances: [...st.allowances.filter((a) => a.id !== r.allowance.id), r.allowance],
        }));
        log.info('reward_redeemed', { cost: -r.pointsDelta });
        afterWrite();
        return ok(r);
      }),

    'points:summary': () => guarded(async () => ok((await call((c) => c.getPoints())).points)),

    'activewin:request-permission': (req) => {
      if (!activeWindow) return stubs['activewin:request-permission'](req);
      return guarded(async () => ok({ outcome: await activeWindow.requestPermission() }));
    },

    'onboarding:install-guardian': (req) => {
      if (mode === 'harness') return stubs['onboarding:install-guardian'](req);
      return guarded(async () => {
        if (mode === 'mock' || store.get().link.status === 'ok') {
          return ok({ outcome: 'already-installed' as const });
        }
        const status = await installer.status();
        if (status?.installed && status.running) {
          session.poller.refreshNow('retry');
          return ok({ outcome: 'already-installed' as const });
        }
        const outcome = await installer.repair();
        afterElevation(outcome);
        const map: Record<string, InstallOutcome> = {
          started: 'installed',
          cancelled: 'cancelled',
          unsupported: 'unsupported',
        };
        const mapped = map[outcome];
        if (!mapped) return fail(uiError('internal', 'install_failed'));
        log.info('guardian_install', { outcome: mapped });
        return ok({ outcome: mapped });
      });
    },
  };

  const harness: CoreHarness | null = options.harness
    ? {
        load(fixture: HarnessFixture): void {
          disposeSession(session);
          currentFixture = fixture;
          store.replace(harnessSnapshot(fixture));
          session = buildSession(fixture);
          session.poller.setEtag(session.fake?.initialEtag() ?? null);
          if (started && !stopped) startSession(session);
        },
        advance(ms: number): void {
          const manual = session.manual;
          if (!manual) return;
          manual.advance(ms);
          const now = manual.now();
          store.update((s) =>
            s.harness ? { ...s, harness: { ...s.harness, frozenNowMs: now } } : s,
          );
        },
        guardianCalls: () => session.fake?.calls() ?? [],
        notifications: () => session.notifications.shown(),
      }
    : null;

  log.info('core_created', {
    mode,
    platform: options.platform,
    version: options.appVersion,
    packaged: options.packaged,
  });

  return {
    getSnapshot: () => store.get(),
    subscribe: (listener) => store.subscribe(listener),
    handlers,
    sendHandlers: {
      'block:create-dismiss': (payload) => {
        try {
          session.create.dismiss(payload?.intentId);
        } catch {
          // never throws across IPC
        }
      },
    },
    start(): void {
      if (started || stopped) return;
      started = true;
      startSession(session);
      syncPlatform(store.get());
    },
    visibilityChanged(): void {
      if (stopped) return;
      session.poller.reschedule();
    },
    patchSnapshot,
    refreshNow(reason: RefreshReason): void {
      if (stopped) return;
      session.poller.refreshNow(reason);
      if (reason === 'resume') {
        session.events.kick();
        // Timers do not count suspended time: the resume poll is usually a 304 (no
        // `onState`), so «Quedan 5 min» is re-planned from the wall clock here.
        session.notifications.onState(store.get().state);
        reminders?.resume();
      }
    },
    async shutdown(budgetMs: number): Promise<void> {
      if (stopped) return;
      stopped = true;
      activeWindow?.stop();
      reminders?.stop();
      nuclearBeat?.stop();
      const s = session;
      let budget: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        s.extend.flush().catch(() => undefined),
        new Promise<void>((resolve) => {
          budget = setTimeout(resolve, Math.max(0, budgetMs));
        }),
      ]);
      if (budget !== null) clearTimeout(budget);
      disposeSession(s);
      if (realDb) realDb.close();
      try {
        notifier.closeAll();
      } catch {
        // nothing on screen
      }
      log.info('core_stopped', {});
    },
    harness,
  };
}
