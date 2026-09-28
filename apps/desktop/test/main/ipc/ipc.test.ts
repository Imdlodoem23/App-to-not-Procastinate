import { emptyAllow, emptyTargets } from '@centrate/shared/guardian-api';
import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, req: unknown) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

import type { Core, IpcSenderInfo, WindowHost } from '../../../src/main/contracts';
import { INVOKE_GUARDS, isValidInvokePayload } from '../../../src/main/ipc-guards';
import { dispatchInvoke, registerIpcHandlers } from '../../../src/main/ipc-handlers';
import { harnessFixture } from '../../../src/shared/fixtures';
import { INVOKE_CHANNELS, type InitPayload } from '../../../src/shared/ipc';
import { fail, ok, uiError } from '../../../src/shared/ui-state';

const BLOCK = 'blk_fixture0000000001';
const EMG = 'emg_fixture0000000001';
const SCH = 'sch_fixture0000000001';

const request = {
  targets: { ...emptyTargets(), serviceIds: ['youtube'] },
  whitelistOnly: false,
  allow: emptyAllow(),
  mode: 'normal',
  durationMinutes: 60,
  endsAt: null,
  reason: '',
  acknowledgeLong: false,
  acknowledgeNoEmergency: false,
};

const VALID: Record<string, unknown> = {
  'app:init': null,
  'block:create': { intentId: 'intent-1', request },
  'block:create-retry': { intentId: 'intent-1' },
  'block:extend': { blockId: BLOCK, addMinutes: 30 },
  'block:extend-undo': { entryId: 'extq_1' },
  'block:extend-retry': { entryId: 'extq_1' },
  'emergency:preview': { blockIds: null },
  'emergency:request': { intentId: 'i-2', blockIds: [BLOCK], phrase: 'Acepto' },
  'emergency:cancel': { id: EMG },
  'emergency:confirm': { intentId: 'i-3', id: EMG },
  'schedules:list': null,
  'schedules:set-enabled': { id: SCH, enabled: false },
  'templates:save': {
    id: null,
    label: 'Mates',
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    whitelistOnly: false,
    mode: null,
    durationMinutes: 45,
    reason: null,
  },
  'templates:delete': { id: 'tpl_abc123' },
  'prefs:set': { theme: 'dark' },
  'pairing:new-code': null,
  'diagnostics:copy': null,
  'data:delete': { intentId: 'i-4', confirm: 'BORRAR' },
  'guardian:repair': null,
  'system:process-names': null,
};

const INVALID: Record<string, unknown[]> = {
  'block:create': [
    { intentId: 'intent 1', request },
    { intentId: 'i', request: { ...request, mode: 'x' } },
    null,
  ],
  'block:create-retry': [{}, { intentId: 5 }],
  'block:extend': [
    { blockId: 'blk_1', addMinutes: 30 },
    { blockId: BLOCK, addMinutes: 0 },
    { blockId: BLOCK, addMinutes: 1.5 },
    { blockId: BLOCK, addMinutes: 30, extra: true },
  ],
  'block:extend-undo': [{ entryId: '' }, { entryId: 'a b' }],
  'emergency:preview': [{ blockIds: ['nope'] }, {}],
  'emergency:request': [
    { intentId: 'i', blockIds: [], phrase: 'x' },
    { intentId: 'i', blockIds: [BLOCK, BLOCK], phrase: 'x' },
    { intentId: 'i', blockIds: [BLOCK], phrase: 'x'.repeat(401) },
  ],
  'emergency:cancel': [{ id: BLOCK }],
  'schedules:set-enabled': [{ id: SCH, enabled: 'yes' }],
  'templates:save': [{ id: null, label: 'x' }],
  'prefs:set': [{ theme: 'blue' }, { token: 'x' }],
  'data:delete': [
    { intentId: 'i', confirm: 5 },
    { intentId: 'i', confirm: 'x'.repeat(40) },
  ],
  'pairing:new-code': [{ port: 1 }],
};

describe('IPC payload guards', () => {
  it('cover every invoke channel', () => {
    expect(Object.keys(INVOKE_GUARDS).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('accept the valid payloads', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(isValidInvokePayload(channel, VALID[channel]), channel).toBe(true);
    }
  });

  it('reject malformed payloads', () => {
    for (const [channel, samples] of Object.entries(INVALID)) {
      for (const sample of samples) {
        expect(
          isValidInvokePayload(channel as never, sample),
          `${channel} ${JSON.stringify(sample)}`,
        ).toBe(false);
      }
    }
  });
});

function fakeCore(): Core & { seen: Array<[string, unknown]> } {
  const seen: Array<[string, unknown]> = [];
  const snapshot = harnessFixture('idle').snapshot;
  const handler =
    (channel: string, answer: unknown) =>
    (req: unknown): unknown => {
      seen.push([channel, req]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
  const table: Record<string, unknown> = {};
  for (const channel of INVOKE_CHANNELS) {
    if (channel === 'app:init') continue;
    table[channel] = handler(channel, channel === 'block:extend-undo' ? 'undone' : ok(null));
  }
  table['diagnostics:copy'] = handler('diagnostics:copy', new Error('boom'));
  table['block:extend-undo'] = handler('block:extend-undo', new Error('boom'));
  return {
    seen,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    handlers: table as Core['handlers'],
    sendHandlers: { 'block:create-dismiss': () => undefined },
    start: () => undefined,
    visibilityChanged: () => undefined,
    refreshNow: () => undefined,
    shutdown: async () => undefined,
    harness: null,
  };
}

const host: WindowHost = {
  windowOf: (sender: IpcSenderInfo) =>
    sender.webContentsId === 1 && sender.frameUrl?.startsWith('file:///app/') ? 'main' : null,
  initPayload: (window) => ({
    window,
    platform: 'linux',
    layout: { maxContentHeight: 800, anchor: 'top' },
    detail: null,
    visible: false,
    harness: null,
  }),
};

const trusted: IpcSenderInfo = { webContentsId: 1, frameUrl: 'file:///app/renderer/index.html' };

describe('invoke dispatch', () => {
  it('rejects untrusted senders', async () => {
    const core = fakeCore();
    await expect(
      dispatchInvoke(
        core,
        host,
        'prefs:set',
        { webContentsId: 2, frameUrl: 'https://evil.example' },
        { theme: 'dark' },
      ),
    ).rejects.toThrow(/untrusted/);
    await expect(
      dispatchInvoke(core, host, 'app:init', { webContentsId: 1, frameUrl: null }, null),
    ).rejects.toThrow();
    expect(core.seen).toHaveLength(0);
  });

  it('answers a bad payload with a 422 without calling the core', async () => {
    const core = fakeCore();
    expect(await dispatchInvoke(core, host, 'prefs:set', trusted, { theme: 'blue' })).toEqual(
      fail(uiError('rejected', 'validation_failed', 422)),
    );
    expect(await dispatchInvoke(core, host, 'block:extend-undo', trusted, 7)).toBe('too_late');
    expect(core.seen).toHaveLength(0);
  });

  it('builds app:init with the current snapshot', async () => {
    const core = fakeCore();
    const init = (await dispatchInvoke(core, host, 'app:init', trusted, null)) as InitPayload;
    expect(init.window).toBe('main');
    expect(init.snapshot).toBe(core.getSnapshot());
  });

  it('never lets an exception escape', async () => {
    const core = fakeCore();
    expect(await dispatchInvoke(core, host, 'diagnostics:copy', trusted, null)).toMatchObject({
      ok: false,
      error: { kind: 'internal' },
    });
    expect(
      await dispatchInvoke(core, host, 'block:extend-undo', trusted, { entryId: 'extq_1' }),
    ).toBe('too_late');
    expect(
      await dispatchInvoke(core, host, 'block:extend', trusted, VALID['block:extend']),
    ).toEqual(ok(null));
  });

  it('registers and removes every invoke channel', async () => {
    const core = fakeCore();
    const dispose = registerIpcHandlers(core, host);
    expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    const fn = handlers.get('prefs:set');
    const answer = await fn?.(
      { sender: { id: 1 }, senderFrame: { url: trusted.frameUrl } },
      { theme: 'light' },
    );
    expect(answer).toEqual(ok(null));
    dispose();
    expect(handlers.size).toBe(0);
  });
});
