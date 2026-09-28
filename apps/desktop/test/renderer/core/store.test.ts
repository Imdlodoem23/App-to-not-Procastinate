import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  harnessLoad,
} from '../../../src/shared/fixtures';
import type {
  CentrateBridge,
  InitPayload,
  PushChannel,
  PushPayload,
  SendChannel,
} from '../../../src/shared/ipc';
import {
  DEFAULT_TEMPLATES,
  draftFromTemplate,
  uiError,
  type DraftSeed,
  type UiSnapshot,
} from '../../../src/shared/ui-state';
import {
  applySnapshotTo,
  detailForRequest,
  initialUiState,
} from '../../../src/renderer/src/store/reducers';
import { confirmCommand } from '../../../src/renderer/src/app/commands';
import { createAppStore } from '../../../src/renderer/src/store/store';
import { bufferPushes, createPushHandlers, newIntentId } from '../../../src/renderer/src/app/push';
import { createWindowServices } from '../../../src/renderer/src/app/window-services';
import { KeyRegistry } from '../../../src/renderer/src/hooks/keys';
import { parseRoute } from '../../../src/renderer/src/app/route';
import { errorPayload, isBenignError } from '../../../src/renderer/src/app/error-payload';

interface FakeBridge extends CentrateBridge {
  sent: { channel: SendChannel; payload: unknown }[];
  push<C extends PushChannel>(channel: C, payload: PushPayload<C>): void;
}

function fakeBridge(): FakeBridge {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const sent: FakeBridge['sent'] = [];
  return {
    platform: 'win32',
    sent,
    invoke: () => Promise.reject(new Error('not used')),
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener as (p: unknown) => void);
      listeners.set(channel, set);
      return () => set.delete(listener as (p: unknown) => void);
    },
    push: (channel, payload) => {
      for (const l of listeners.get(channel) ?? []) l(payload);
    },
  };
}

function storeFor(id: Parameters<typeof harnessFixture>[0], window?: 'main' | 'detail') {
  const fixture = harnessFixture(id);
  const bridge = fakeBridge();
  const store = createAppStore(bridge, fixtureUiState(fixture, window), harnessLoad(fixture));
  return { fixture, bridge, store };
}

function bumped(snapshot: UiSnapshot, patch: Partial<UiSnapshot> = {}, by = 1): UiSnapshot {
  return { ...snapshot, ...patch, rev: snapshot.rev + by };
}

describe('reducers', () => {
  it('ignores snapshots that are not newer', () => {
    const { store } = storeFor('idle');
    const s = store.getState();
    expect(applySnapshotTo(s, { ...s.snapshot })).toBeNull();
    expect(applySnapshotTo(s, { ...s.snapshot, rev: s.snapshot.rev - 1 })).toBeNull();
    expect(applySnapshotTo(s, bumped(s.snapshot))?.snapshot.rev).toBe(s.snapshot.rev + 1);
  });

  it('closes the card whose create the guardian confirmed, in the same update', () => {
    const { store } = storeFor('pending');
    const s = store.getState();
    const card = s.main.card;
    expect(card).not.toBeNull();
    const next = applySnapshotTo(
      s,
      bumped(s.snapshot, {
        ops: {
          ...s.snapshot.ops,
          create: null,
          lastCreated: { intentId: card?.intentId ?? '', blockId: 'blk_fixture0000000099' },
        },
      }),
    );
    expect(next?.main.card).toBeNull();
    expect(next?.main.composer.text).toBe('');
  });

  it('builds the first state from app:init, with harness local state', () => {
    const fixture = harnessFixture('typing');
    const init: InitPayload = {
      window: 'main',
      platform: 'win32',
      snapshot: fixture.snapshot,
      layout: { maxContentHeight: 990, anchor: 'bottom' },
      detail: null,
      visible: false,
      harness: harnessLoad(fixture),
    };
    const state = initialUiState(init);
    expect(state.main.composer.text).toBe('no veo YouTube en una hora');
    expect(state.env).toEqual({
      window: 'main',
      platform: 'win32',
      layout: { maxContentHeight: 990, anchor: 'bottom' },
      detail: null,
      visible: false,
    });
    expect(initialUiState({ ...init, harness: null }).main.composer.text).toBe('');
  });

  it('seeds the detail window from its request and drops help and armed', () => {
    const { store } = storeFor('emergency-ready', 'detail');
    const s = store.getState();
    expect(s.detail.armed).not.toBeNull();
    const seed: DraftSeed = {
      phrase: 'no veo YouTube mañana tarde',
      targets: {
        serviceIds: ['youtube'],
        categoryIds: [],
        appIds: [],
        customDomains: [],
        customProcesses: [],
      },
      end: null,
      mode: null,
      reason: null,
    };
    const bloqueos = detailForRequest(
      s.detail,
      { name: 'bloqueos', seed, focus: 'form' },
      s.snapshot,
    );
    expect(bloqueos.armed).toBeNull();
    expect(bloqueos.bloqueos.seedPhrase).toBe(seed.phrase);
    expect(bloqueos.bloqueos.form.targets.serviceIds).toEqual(['youtube']);
    expect(bloqueos.bloqueos.form.end).toEqual({ kind: 'duration', minutes: 60 });
    const ajustes = detailForRequest(s.detail, { name: 'ajustes', group: 'datos' }, s.snapshot);
    expect(ajustes.ajustes.group).toBe('datos');
    const emergencia = detailForRequest(
      s.detail,
      { name: 'emergencia', blockIds: ['blk_fixture0000000021'] },
      s.snapshot,
    );
    expect(emergencia.emergencia.blockIds).toEqual(['blk_fixture0000000021']);
    // Without a seed the form is kept as the user left it.
    expect(
      detailForRequest(s.detail, { name: 'bloqueos', seed: null, focus: null }, s.snapshot)
        .bloqueos,
    ).toBe(s.detail.bloqueos);
  });
});

describe('confirm commands (tray template, Bloqueos draft)', () => {
  let n = 0;
  const mint = (): string => `intent-new-${(n += 1)}`;
  const deberes = DEFAULT_TEMPLATES[0];
  if (!deberes) throw new Error('no templates');

  it('opens a card from a template or a Bloqueos draft, disarmed, with the button focused', () => {
    const { store } = storeFor('idle');
    const { snapshot } = store.getState();
    const main = {
      ...store.getState().main,
      armed: { id: 'x', at: 1 },
      help: { row: 'a', item: 'b' },
    };
    const fromTemplate = confirmCommand(
      { type: 'confirm-template', templateId: 'deberes' },
      snapshot,
      main,
      mint,
    );
    expect(fromTemplate.opened).toBe(true);
    expect(fromTemplate.focus).toBe('confirm');
    expect(fromTemplate.dismissIntentId).toBeNull();
    expect(fromTemplate.main).toMatchObject({ armed: null, help: null });
    expect(fromTemplate.main.card).toMatchObject({
      origin: 'tray',
      templateId: 'deberes',
      step: 'edit',
      draft: draftFromTemplate(deberes, snapshot.prefs),
    });
    expect(fromTemplate.main.card?.intentId).toMatch(/^intent-new-\d+$/);

    const unknown = confirmCommand(
      { type: 'confirm-template', templateId: 'nope' },
      snapshot,
      main,
      mint,
    );
    expect(unknown.opened).toBe(false);
    expect(unknown.main).toBe(main);

    const draft = draftFromTemplate(deberes, snapshot.prefs);
    const fromDraft = confirmCommand({ type: 'confirm-draft', draft }, snapshot, main, mint);
    expect(fromDraft.main.card).toMatchObject({ origin: 'form', draft, templateId: null });
  });

  it('never replaces «Bloqueando…» or an unanswered create (it may have landed)', () => {
    for (const id of ['pending', 'guardian-timeout'] as const) {
      const { store } = storeFor(id);
      const { snapshot, main } = store.getState();
      expect(main.card).not.toBeNull();
      const draft = draftFromTemplate(deberes, snapshot.prefs);
      for (const command of [
        { type: 'confirm-template', templateId: 'leer' } as const,
        { type: 'confirm-draft', draft } as const,
      ]) {
        const result = confirmCommand(command, snapshot, main, mint);
        expect(result.opened).toBe(false);
        expect(result.main).toBe(main);
        expect(result.dismissIntentId).toBeNull();
      }
    }
  });

  it('replaces a rejected create and dismisses it, with or without its card', () => {
    const { store } = storeFor('guardian-timeout');
    const { snapshot, main } = store.getState();
    const create = snapshot.ops.create;
    if (!create) throw new Error('fixture without a create');
    const rejected: UiSnapshot = {
      ...snapshot,
      ops: {
        ...snapshot.ops,
        create: { ...create, error: uiError('rejected', 'duration_out_of_range', 422) },
      },
    };
    const withCard = confirmCommand(
      { type: 'confirm-template', templateId: 'leer' },
      rejected,
      main,
      mint,
    );
    expect(withCard.opened).toBe(true);
    expect(withCard.dismissIntentId).toBe(create.intentId);
    expect(withCard.main.card?.intentId).not.toBe(create.intentId);

    const cardless = confirmCommand(
      { type: 'confirm-template', templateId: 'leer' },
      rejected,
      { ...main, card: null },
      mint,
    );
    expect(cardless.opened).toBe(true);
    expect(cardless.dismissIntentId).toBe(create.intentId);
  });
});

describe('store', () => {
  it('applies only newer snapshots', () => {
    const { store } = storeFor('idle');
    const first = store.getState().snapshot;
    store.getState().applySnapshot({ ...first, rev: first.rev - 5 });
    expect(store.getState().snapshot).toBe(first);
    const next = bumped(first);
    store.getState().applySnapshot(next);
    expect(store.getState().snapshot).toBe(next);
  });

  it('keeps references when an update changes nothing', () => {
    const { store } = storeFor('idle');
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().updateMain((m) => m);
    store.getState().setEnv({ visible: true });
    store.getState().setHelp(null);
    store.getState().setArmed(null);
    store.getState().setLayout({ height: 300, density: 'regular', scroll: false });
    store.getState().setLayout({ height: 300, density: 'regular', scroll: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('routes help and armed to the window’s own local state', () => {
    const main = storeFor('idle', 'main').store;
    main.getState().setHelp({ row: 'templates', item: 'leer' });
    main.getState().setArmed({ id: 'x', at: 1 });
    expect(main.getState().main.help).toEqual({ row: 'templates', item: 'leer' });
    expect(main.getState().main.armed).toEqual({ id: 'x', at: 1 });
    expect(main.getState().detail.help).toBeNull();

    const detail = storeFor('ajustes', 'detail').store;
    detail.getState().setHelp({ row: 'tema', item: 'dark' });
    expect(detail.getState().detail.help).toEqual({ row: 'tema', item: 'dark' });
    expect(detail.getState().main.help).toBeNull();
  });

  it('counts harness loads and replaces local state', () => {
    const { store } = storeFor('idle');
    expect(store.getState().harnessSeq).toBe(1);
    const typing = harnessFixture('typing');
    store.getState().loadHarness(harnessLoad(typing));
    expect(store.getState().harnessStateId).toBe('typing');
    expect(store.getState().harnessSeq).toBe(2);
    expect(store.getState().main.composer.text).toBe('no veo YouTube en una hora');
  });
});

describe('push handlers', () => {
  function setup(
    id: Parameters<typeof harnessFixture>[0] = 'idle',
    window: 'main' | 'detail' = 'main',
  ) {
    const { store, bridge, fixture } = storeFor(id, window);
    const services = createWindowServices(new KeyRegistry('win32', () => undefined));
    return { store, bridge, fixture, services, handlers: createPushHandlers(store, services) };
  }

  it('answers ui:prepare-show with the measured layout', () => {
    const { handlers, services, bridge, store } = setup();
    const epoch = store.getState().clockEpoch;
    services.setMeasurer(() => ({ height: 321, density: 'regular', scroll: false }));
    handlers['ui:prepare-show']({ seq: 7, layout: { maxContentHeight: 500, anchor: 'bottom' } });
    expect(store.getState().env.layout.maxContentHeight).toBe(500);
    expect(store.getState().clockEpoch).toBe(epoch + 1);
    expect(bridge.sent).toEqual([
      {
        channel: 'window:show-ack',
        payload: { seq: 7, layout: { height: 321, density: 'regular', scroll: false } },
      },
    ]);
  });

  it('does not ack before the shell can measure', () => {
    const { handlers, bridge } = setup();
    handlers['ui:prepare-show']({ seq: 1, layout: { maxContentHeight: 500, anchor: 'bottom' } });
    expect(bridge.sent).toEqual([]);
  });

  it('focuses the field on show and disarms on hide', () => {
    const { handlers, services, store } = setup('emergency-ready', 'detail');
    const field = vi.fn(() => true);
    services.registerFocus('field', field);
    handlers['ui:visibility']({ visible: true, focused: true, reason: 'tray', focusField: true });
    expect(field).toHaveBeenCalledTimes(1);
    expect(store.getState().detail.armed).not.toBeNull();
    handlers['ui:visibility']({ visible: false, focused: false, reason: null, focusField: false });
    expect(store.getState().env.visible).toBe(false);
    expect(store.getState().detail.armed).toBeNull();
  });

  it('opens the confirmation card for a tray template and focuses its button', () => {
    const { handlers, services, store, bridge } = setup();
    const confirm = vi.fn(() => true);
    services.registerFocus('confirm', confirm);
    handlers['ui:command']({ type: 'confirm-template', templateId: 'leer' });
    const card = store.getState().main.card;
    expect(card?.templateId).toBe('leer');
    expect(card?.intentId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bridge.sent).toEqual([]);
  });

  it('keeps «Bloqueando…» and the unanswered card, and only focuses them', () => {
    for (const id of ['pending', 'guardian-timeout'] as const) {
      const { handlers, services, store, bridge } = setup(id);
      const confirm = vi.fn(() => true);
      services.registerFocus('confirm', confirm);
      const before = store.getState().main;
      handlers['ui:command']({ type: 'confirm-template', templateId: 'leer' });
      expect(store.getState().main).toBe(before);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(bridge.sent).toEqual([]);
    }
  });

  it('dismisses the rejected create a tray template replaces', () => {
    const { handlers, store, bridge } = setup('guardian-timeout');
    const { snapshot } = store.getState();
    const create = snapshot.ops.create;
    if (!create) throw new Error('fixture without a create');
    store.getState().applySnapshot(
      bumped(snapshot, {
        ops: { ...snapshot.ops, create: { ...create, error: uiError('rejected', 'x', 422) } },
      }),
    );
    handlers['ui:command']({ type: 'confirm-template', templateId: 'leer' });
    expect(store.getState().main.card?.templateId).toBe('leer');
    expect(bridge.sent).toEqual([
      { channel: 'block:create-dismiss', payload: { intentId: create.intentId } },
    ]);
  });

  it("keeps a fixture's armed «¿Seguro?» through the retarget that follows its load", () => {
    const { handlers, store } = setup('idle', 'detail');
    const fixture = harnessFixture('emergency-ready');
    handlers['ui:harness'](harnessLoad(fixture));
    expect(store.getState().detail.armed?.id).toBe('emergency-unlock');
    if (!fixture.detailRequest) throw new Error('fixture without a detail request');
    handlers['ui:detail'](fixture.detailRequest);
    expect(store.getState().detail.armed?.id).toBe('emergency-unlock');
    // Any later retarget (a door) disarms, as does one after the local state changed.
    handlers['ui:detail'](fixture.detailRequest);
    expect(store.getState().detail.armed).toBeNull();
    handlers['ui:harness'](harnessLoad(fixture));
    store.getState().setHelp({ row: 'x', item: 'y' });
    handlers['ui:detail'](fixture.detailRequest);
    expect(store.getState().detail.armed).toBeNull();
    expect(store.getState().detail.help).toBeNull();
  });

  it('retargets the detail window', () => {
    const { handlers, store } = setup('ajustes', 'detail');
    handlers['ui:detail']({ name: 'ajustes', group: 'sistema' });
    expect(store.getState().env.detail).toEqual({ name: 'ajustes', group: 'sistema' });
    expect(store.getState().detail.ajustes.group).toBe('sistema');
  });

  it('buffers pushes until the store exists, then replays them in order', () => {
    const { store, services } = setup();
    const bridge = fakeBridge();
    const buffer = bufferPushes(bridge);
    const s0 = store.getState().snapshot;
    bridge.push('ui:snapshot', bumped(s0, {}, 1));
    bridge.push('ui:snapshot', bumped(s0, {}, 2));
    expect(store.getState().snapshot.rev).toBe(s0.rev);
    buffer.attach(createPushHandlers(store, services));
    expect(store.getState().snapshot.rev).toBe(s0.rev + 2);
    bridge.push('ui:snapshot', bumped(s0, {}, 3));
    expect(store.getState().snapshot.rev).toBe(s0.rev + 3);
    buffer.dispose();
    bridge.push('ui:snapshot', bumped(s0, {}, 4));
    expect(store.getState().snapshot.rev).toBe(s0.rev + 3);
  });

  it('makes valid intent ids', () => {
    expect(newIntentId()).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(newIntentId()).not.toBe(newIntentId());
  });
});

describe('route', () => {
  it('reads the window and the harness state', () => {
    expect(parseRoute('?window=main&state=idle')).toEqual({
      window: 'main',
      detail: null,
      stateId: 'idle',
      kit: false,
    });
    expect(parseRoute('?window=detail')).toEqual({
      window: 'detail',
      detail: null,
      stateId: null,
      kit: false,
    });
    expect(parseRoute('?window=ajustes&state=ajustes-pairing&kit')).toEqual({
      window: 'detail',
      detail: 'ajustes',
      stateId: 'ajustes-pairing',
      kit: true,
    });
    expect(parseRoute('')).toMatchObject({ window: 'main', stateId: null });
    expect(parseRoute('?window=evil&state=../x')).toMatchObject({ window: 'main', stateId: null });
  });
});

describe('error reporting', () => {
  it('trims payloads to the send guard limits and skips the benign ResizeObserver notice', () => {
    const payload = errorPayload(new Error('x'.repeat(5_000)));
    expect(payload.message.length).toBeLessThanOrEqual(2_000);
    expect(payload.stack).not.toBeNull();
    expect(errorPayload('plain').stack).toBeNull();
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(
      true,
    );
    expect(isBenignError('TypeError: x')).toBe(false);
  });
});

describe('fixture clock', () => {
  it('is the harness now', () => {
    expect(harnessFixture('idle').snapshot.harness?.frozenNowMs).toBe(HARNESS_NOW);
  });
});
