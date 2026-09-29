/**
 * Browser harness bridge (dev only: `npm run dev -w apps/desktop`, then open the renderer URL
 * with `?window=main&state=<id>`; docs/DESKTOP.md §10). Without the preload there is no
 * `window.centrate`, so this serves the `?state=` fixture from memory: reads answer from
 * `fixture.fake`, preferences apply live (theme), and creates and extensions are simulated
 * roughly (a «Bloqueando…» moment, then the block; 5 s undo) so sections can be clicked through.
 * Emergency writes are not simulated here; use the Electron harness for those flows.
 *
 * Imported only behind `import.meta.env.DEV`, so production bundles contain none of it (nor the
 * fixtures).
 */
import { DATA_DELETE_CONFIRM_WORDS, emptyAllow } from '@centrate/shared/guardian-api';
import type { Block } from '@centrate/shared/domain';
import {
  DISPLAY_PRESETS,
  fixtureInLocale,
  harnessFixture,
  harnessLoad,
  isHarnessStateId,
  layoutForDisplay,
} from '../../../shared/fixtures';
import type {
  CentrateBridge,
  InitPayload,
  InvokeChannel,
  InvokeReq,
  InvokeRes,
  PushChannel,
  PushPayload,
  SendChannel,
  SendPayload,
} from '../../../shared/ipc';
import { phase5InvokeStubs } from '../../../shared/phase5-stubs';
import {
  UI_TIMINGS,
  applyUiPrefsPatch,
  defaultDetailRequest as defaultRequest,
  fail,
  ok,
  uiError,
  type UiSnapshot,
} from '../../../shared/ui-state';
import type { RendererRoute } from './route';

type Handler<C extends InvokeChannel> = (req: InvokeReq<C>) => InvokeRes<C>;

export function createMemoryBridge(route: RendererRoute): CentrateBridge {
  const base = harnessFixture(isHarnessStateId(route.stateId) ? route.stateId : 'idle');
  const fixture = route.lang ? fixtureInLocale(base, route.lang) : base;
  const preset = DISPLAY_PRESETS[fixture.display];
  const listeners = new Map<PushChannel, Set<(payload: never) => void>>();
  let snapshot: UiSnapshot = fixture.snapshot;
  let created = 0;

  const emit = <C extends PushChannel>(channel: C, payload: PushPayload<C>): void => {
    for (const listener of listeners.get(channel) ?? []) {
      (listener as (p: PushPayload<C>) => void)(payload);
    }
  };
  const now = (): number => snapshot.harness?.frozenNowMs ?? Date.now();
  const publish = (next: Omit<UiSnapshot, 'rev'>): void => {
    snapshot = { ...next, rev: snapshot.rev + 1 };
    emit('ui:snapshot', snapshot);
  };
  const log = (what: string, payload: unknown): void => {
    console.info(`[harness] ${what}`, payload);
  };

  const detail =
    route.detail !== null
      ? fixture.detailRequest?.name === route.detail
        ? fixture.detailRequest
        : defaultRequest(route.detail)
      : fixture.detailRequest;

  const init: InitPayload = {
    window: route.window,
    platform: preset.platform,
    snapshot,
    layout: layoutForDisplay(preset),
    detail: route.window === 'detail' ? (detail ?? defaultRequest('bloqueos')) : null,
    visible: true,
    harness: harnessLoad(fixture),
  };

  const handlers: { [C in InvokeChannel]: Handler<C> } = {
    // Phase 5 reads answer from the fixture (`fixture.fake`, `fixture.local`).
    ...phase5InvokeStubs(() => fixture, now),
    'app:init': () => init,
    'block:create': ({ intentId, request }) => {
      publish({
        ...snapshot,
        ops: {
          ...snapshot.ops,
          create: {
            intentId,
            request,
            status: 'sending',
            startedAt: now(),
            attempts: 1,
            error: null,
          },
        },
      });
      const blockId = `blk_browser${String(++created).padStart(10, '0')}`;
      setTimeout(
        () => {
          const state = snapshot.state;
          if (!state) return;
          const minutes =
            request.durationMinutes ??
            Math.ceil((Date.parse(request.endsAt ?? '') - now()) / 60_000);
          const block: Block = {
            id: blockId as Block['id'],
            kind: 'manual',
            mode: request.mode,
            status: 'active',
            targets: request.targets,
            whitelistOnly: request.whitelistOnly,
            allow: emptyAllow(),
            reason: request.reason,
            createdAt: new Date(now()).toISOString(),
            startsAt: new Date(now()).toISOString(),
            endsAt: new Date(now() + minutes * 60_000).toISOString(),
            originalEndsAt: new Date(now() + minutes * 60_000).toISOString(),
            endedAt: null,
            extendedMinutes: 0,
            scheduleId: null,
            punishmentId: null,
            attemptsCounted: 0,
            emergencyEligible: request.mode === 'normal' || request.mode === 'strict',
            pointsDelta: null,
          };
          const blocks = [...state.blocks, block].sort(
            (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt),
          );
          publish({
            ...snapshot,
            state: { ...state, blocks },
            ops: { ...snapshot.ops, create: null, lastCreated: { intentId, blockId: block.id } },
          });
        },
        Math.max(600, fixture.fake.behaviour.latencyMs),
      );
      return ok({ blockId: blockId as Block['id'] });
    },
    'block:create-retry': () => fail(uiError('timeout')),
    'block:extend': ({ blockId, addMinutes }) => {
      const block = snapshot.state?.blocks.find((b) => b.id === blockId);
      if (!block) return fail(uiError('rejected', 'block_not_active', 409));
      const entryId = `extend-browser-${Date.now()}`;
      const commitAt = now() + UI_TIMINGS.extendUndoMs;
      publish({
        ...snapshot,
        ops: {
          ...snapshot.ops,
          extendQueue: [
            ...snapshot.ops.extendQueue,
            {
              id: entryId,
              blockId,
              addMinutes,
              createdAt: now(),
              commitAt,
              projectedEndsAt: new Date(
                Date.parse(block.endsAt) + addMinutes * 60_000,
              ).toISOString(),
              status: 'waiting',
              error: null,
            },
          ],
        },
      });
      setTimeout(() => {
        const entry = snapshot.ops.extendQueue.find((e) => e.id === entryId);
        const state = snapshot.state;
        if (!entry || !state) return;
        publish({
          ...snapshot,
          state: {
            ...state,
            blocks: state.blocks.map((b) =>
              b.id === blockId
                ? {
                    ...b,
                    endsAt: entry.projectedEndsAt,
                    extendedMinutes: b.extendedMinutes + entry.addMinutes,
                  }
                : b,
            ),
          },
          ops: {
            ...snapshot.ops,
            extendQueue: snapshot.ops.extendQueue.filter((e) => e.id !== entryId),
          },
        });
      }, UI_TIMINGS.extendUndoMs);
      return ok({ entryId, commitAt });
    },
    'block:extend-undo': ({ entryId }) => {
      const entry = snapshot.ops.extendQueue.find((e) => e.id === entryId);
      if (!entry || entry.status !== 'waiting') return 'too_late';
      publish({
        ...snapshot,
        ops: {
          ...snapshot.ops,
          extendQueue: snapshot.ops.extendQueue.filter((e) => e.id !== entryId),
        },
      });
      return 'undone';
    },
    'block:extend-retry': () => ok(null),
    'emergency:preview': () => ok(fixture.fake.emergencyPreview),
    'emergency:request': () => fail(uiError('internal', 'not_simulated', 500)),
    'emergency:cancel': () => fail(uiError('internal', 'not_simulated', 500)),
    'emergency:confirm': () => fail(uiError('internal', 'not_simulated', 500)),
    'schedules:list': () => ok(fixture.fake.schedules),
    'schedules:set-enabled': ({ id, enabled }) => {
      const schedule = fixture.fake.schedules.find((s) => s.id === id);
      return schedule ? ok({ ...schedule, enabled }) : fail(uiError('rejected', 'not_found', 404));
    },
    'templates:save': (input) => {
      const templates = [
        ...snapshot.templates.filter((t) => t.id !== input.id),
        { ...input, id: input.id ?? `tpl_browser${Date.now()}`, builtin: false },
      ];
      publish({ ...snapshot, templates });
      return ok(templates);
    },
    'templates:delete': ({ id }) => {
      const templates = snapshot.templates.filter((t) => t.builtin || t.id !== id);
      publish({ ...snapshot, templates });
      return ok(templates);
    },
    'prefs:set': (patch) => {
      const prefs = applyUiPrefsPatch(snapshot.prefs, patch);
      publish({ ...snapshot, prefs });
      return ok(prefs);
    },
    'pairing:new-code': () => ok(fixture.fake.pairingCode),
    'diagnostics:copy': () => ok({ source: 'guardian' as const }),
    'data:delete': ({ confirm }) =>
      DATA_DELETE_CONFIRM_WORDS.includes(confirm.trim().toUpperCase())
        ? ok({
            epoch: 'ep_browser0000000001' as never,
            carryOverBalance: 0,
            keptBlockIds: (snapshot.state?.blocks ?? []).map((b) => b.id),
            keptPunishmentIds: [],
            keptScheduleIds: [],
          })
        : fail(uiError('rejected', 'confirm_word_mismatch', 422)),
    'guardian:repair': () => ok({ outcome: 'unsupported' as const }),
    'system:process-names': () => ok(fixture.fake.processNames),
  };

  return {
    platform: preset.platform,
    invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
      if (channel !== 'app:init') log(`invoke ${channel}`, req);
      const handler = handlers[channel] as Handler<C>;
      return Promise.resolve(handler(req));
    },
    send<C extends SendChannel>(channel: C, payload: SendPayload<C>): void {
      if (channel === 'window:layout') {
        const report = payload as SendPayload<'window:layout'>;
        document.documentElement.style.setProperty('--harness-window-height', `${report.height}px`);
        return;
      }
      if (channel === 'window:confirm-draft' && route.window === 'main') {
        emit('ui:command', {
          type: 'confirm-draft',
          draft: (payload as SendPayload<'window:confirm-draft'>).draft,
        });
      }
      log(`send ${channel}`, payload);
    },
    on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): () => void {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(channel, set);
      return () => {
        set.delete(listener as (payload: never) => void);
      };
    },
  };
}
