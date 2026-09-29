import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMERGENCY_RULES } from '@centrate/shared/points';
import { parseIntent } from '@centrate/shared/parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
}));

import type { Core, CoreOptions } from '../../../src/main/contracts';
import { createCore } from '../../../src/main/guardian/core';
import { createManualClock } from '../../../src/main/guardian/clock';
import { createMemoryLogger } from '../../../src/main/logs/logger';
import { createRecordingNotifier } from '../../../src/main/notifications/types';
import { FEATURES } from '../../../src/shared/features';
import { HARNESS_NOW, harnessFixture, type HarnessStateId } from '../../../src/shared/fixtures';
import {
  DEFAULT_PREFS,
  draftFromParse,
  draftToCreateRequest,
  type UiSnapshot,
} from '../../../src/shared/ui-state';
import { hostStub, run, settle } from './helpers';

const ctx = { window: 'main' as const };
const dirs: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown(0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'centrate-core-'));
  dirs.push(d);
  return d;
}

function options(patch: Partial<CoreOptions>): CoreOptions {
  return {
    platform: 'linux',
    appVersion: '0.1.0',
    packaged: false,
    userDataDir: temp(),
    sysDir: '/nonexistent/centrate',
    guardianBinary: null,
    clock: createManualClock(HARNESS_NOW),
    features: FEATURES,
    harness: null,
    host: hostStub(),
    ...patch,
  };
}

function harnessCore(id: HarnessStateId, host = hostStub()) {
  const fixture = harnessFixture(id);
  const core = createCore(options({ harness: fixture, host }), {
    logger: createMemoryLogger(),
    exec: async () => ({ code: 1, stdout: '', stderr: '', error: null }),
  });
  cores.push(core);
  const harness = core.harness;
  if (!harness) throw new Error('no harness');
  const published: UiSnapshot[] = [];
  core.subscribe((s) => published.push(s));
  return { fixture, core, harness, host, published };
}

/** Advance the harness clock in steps, letting async chains run between timers. */
async function advance(core: Core, ms: number): Promise<void> {
  const harness = core.harness;
  if (!harness) throw new Error('no harness');
  let left = ms;
  while (left > 0) {
    await settle();
    const step = Math.min(left, 100);
    harness.advance(step);
    left -= step;
  }
  await settle();
}

function youtubeRequest() {
  const draft = draftFromParse(parseIntent('no veo YouTube en una hora', { now: new Date(HARNESS_NOW) }), DEFAULT_PREFS);
  if (!draft) throw new Error('not understood');
  return draftToCreateRequest(draft, HARNESS_NOW);
}

describe('core in harness mode', () => {
  it('serves the fixture unchanged: starting publishes nothing', async () => {
    const t = harnessCore('one-block');
    expect(t.core.getSnapshot().state).toEqual(t.fixture.snapshot.state);
    t.core.start();
    await settle(30);
    expect(t.published).toHaveLength(0);
    await advance(t.core, 4_000);
    // Only the frozen clock moved.
    expect(t.published.every((s) => s.state === t.core.getSnapshot().state)).toBe(true);
    expect(t.core.getSnapshot().harness?.frozenNowMs).toBe(HARNESS_NOW + 4_000);
    expect(t.harness.guardianCalls().some((c) => c.method === 'getState')).toBe(true);
  });

  it('creates a block: «Bloqueando…», then active with the intent as key', async () => {
    const t = harnessCore('idle');
    t.core.start();
    await settle();
    const r = await t.core.handlers['block:create']({ intentId: 'intent-core-1', request: youtubeRequest() }, ctx);
    expect(r.ok).toBe(true);
    await settle();
    const snap = t.core.getSnapshot();
    expect(snap.ops.lastCreated?.intentId).toBe('intent-core-1');
    expect(snap.state?.blocks).toHaveLength(1);
    expect(t.published.some((s) => s.ops.create?.status === 'sending')).toBe(true);
    const create = t.harness.guardianCalls().find((c) => c.method === 'createBlock');
    expect(create?.idempotencyKey).toBe('intent-core-1');
  });

  it('guardian-timeout: «Reintentar» times out again with the same key', async () => {
    const t = harnessCore('guardian-timeout');
    t.core.start();
    await settle();
    const retry = t.core.handlers['block:create-retry']({ intentId: 'intent-fixture-0001' }, ctx);
    await advance(t.core, 3_000);
    expect(await retry).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    const keys = t.harness.guardianCalls().filter((c) => c.method === 'createBlock').map((c) => c.idempotencyKey);
    expect(keys).toEqual(['intent-fixture-0001']);
    expect(t.core.getSnapshot().ops.create?.status).toBe('failed');
  });

  it('pending: the adopted create completes on advance', async () => {
    const t = harnessCore('pending');
    t.core.start();
    await settle();
    expect(t.core.getSnapshot().ops.create?.status).toBe('sending');
    await advance(t.core, 2_000);
    const snap = t.core.getSnapshot();
    expect(snap.ops.create).toBeNull();
    expect(snap.ops.lastCreated?.intentId).toBe('intent-fixture-0001');
    expect(snap.state?.blocks).toHaveLength(1);
  });

  it('extend-undo: the fixture entry is sent at its commit time', async () => {
    const t = harnessCore('extend-undo');
    t.core.start();
    await advance(t.core, 3_700);
    expect(t.harness.guardianCalls().filter((c) => c.method === 'extendBlock')).toHaveLength(0);
    await advance(t.core, 200);
    expect(t.harness.guardianCalls().filter((c) => c.method === 'extendBlock')).toHaveLength(1);
    const block = t.core.getSnapshot().state?.blocks[0];
    const original = t.fixture.snapshot.state?.blocks[0];
    expect(Date.parse(block?.endsAt ?? '') - Date.parse(original?.endsAt ?? '')).toBe(30 * 60_000);
  });

  it('extend + «Deshacer» sends nothing', async () => {
    const t = harnessCore('one-block');
    t.core.start();
    const blockId = t.fixture.snapshot.state?.blocks[0]?.id;
    if (!blockId) throw new Error('no block');
    const r = await t.core.handlers['block:extend']({ blockId, addMinutes: 15 }, ctx);
    if (!r.ok) throw new Error('refused');
    await advance(t.core, 2_000);
    expect(await t.core.handlers['block:extend-undo']({ entryId: r.value.entryId }, ctx)).toBe('undone');
    await advance(t.core, 10_000);
    expect(t.harness.guardianCalls().filter((c) => c.method === 'extendBlock')).toHaveLength(0);
  });

  it('emergency: request → counting → ready → confirm', async () => {
    const t = harnessCore('emergencia');
    t.core.start();
    await settle();
    const preview = await t.core.handlers['emergency:preview']({ blockIds: null }, ctx);
    expect(preview).toMatchObject({ ok: true, value: { eligible: true, penaltyPoints: 620, streakDays: 5 } });
    const blockIds = preview.ok ? preview.value.blockIds : [];
    const bad = await t.core.handlers['emergency:request']({ intentId: 'emg-1', blockIds, phrase: 'no' }, ctx);
    expect(bad).toMatchObject({ ok: false, error: { code: 'phrase_mismatch' } });
    const r = await t.core.handlers['emergency:request'](
      { intentId: 'emg-2', blockIds, phrase: EMERGENCY_RULES.phrases.es },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.code);
    expect(t.core.getSnapshot().state?.emergency?.status).toBe('counting');
    await advance(t.core, 10 * 60_000);
    expect(t.core.getSnapshot().state?.emergency?.status).toBe('ready');
    const confirmed = await t.core.handlers['emergency:confirm']({ intentId: 'emg-3', id: r.value.id }, ctx);
    expect(confirmed).toMatchObject({ ok: true, value: { penaltyApplied: 620, balanceAfter: 620 } });
    await settle();
    expect(t.core.getSnapshot().state?.blocks).toHaveLength(0);
    expect(t.core.getSnapshot().state?.emergency).toBeNull();
  });

  it('notifications: a block started while hidden is shown once', async () => {
    const t = harnessCore('idle', hostStub({ anyVisible: false }));
    t.core.start();
    await settle();
    await t.core.handlers['block:create']({ intentId: 'intent-core-2', request: youtubeRequest() }, ctx);
    await advance(t.core, 1_500);
    expect(t.harness.notifications()).toMatchObject([
      { title: 'Bloqueo iniciado', body: 'YouTube hasta las 18:00', kinds: ['block_started'] },
    ]);
  });

  it('loads another fixture in place', async () => {
    const t = harnessCore('idle');
    t.core.start();
    await settle();
    const rev = t.core.getSnapshot().rev;
    t.harness.load(harnessFixture('three-blocks'));
    const snap = t.core.getSnapshot();
    expect(snap.rev).toBeGreaterThan(rev);
    expect(snap.state?.blocks).toHaveLength(3);
    expect(snap.harness?.stateId).toBe('three-blocks');
    // A fresh fake guardian: only the new session's reads so far.
    expect(
      t.harness.guardianCalls().every((c) => ['health', 'getState', 'getEvents'].includes(c.method)),
    ).toBe(true);
  });

  it('answers the detail windows (schedules, pairing, processes, prefs, templates)', async () => {
    const t = harnessCore('ajustes');
    t.core.start();
    const schedules = await t.core.handlers['schedules:list'](null, ctx);
    expect(schedules.ok && schedules.value).toHaveLength(2);
    const disabled = schedules.ok ? schedules.value[1] : undefined;
    const enabled = await t.core.handlers['schedules:set-enabled']({ id: disabled?.id ?? 'sch_x', enabled: true }, ctx);
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true } });
    expect(await t.core.handlers['pairing:new-code'](null, ctx)).toMatchObject({ ok: true, value: { code: '482913' } });
    expect(await t.core.handlers['system:process-names'](null, ctx)).toMatchObject({ ok: true });
    expect(await t.core.handlers['prefs:set']({ theme: 'dark' }, ctx)).toMatchObject({ ok: true, value: { theme: 'dark' } });
    expect(t.core.getSnapshot().prefs.theme).toBe('dark');
    expect(await t.core.handlers['guardian:repair'](null, ctx)).toEqual({ ok: true, value: { outcome: 'unsupported' } });
    const deleted = await t.core.handlers['templates:delete']({ id: 'deberes' }, ctx);
    expect(deleted).toMatchObject({ ok: false, error: { code: 'builtin_template' } });
  });
});

describe('core with the mock guardian (CENTRATE_MOCK_GUARDIAN=1)', () => {
  it('runs a whole session: create, extend, notifications, diagnostics, delete, quit', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const host = hostStub({ anyVisible: false });
    const notifier = createRecordingNotifier();
    const userDataDir = temp();
    const core = createCore(options({ clock, host, userDataDir }), {
      env: { CENTRATE_MOCK_GUARDIAN: '1' },
      logger: createMemoryLogger(),
      notifier,
    });
    cores.push(core);
    core.start();
    await run(clock, 100);
    expect(core.getSnapshot().link.status).toBe('ok');
    const created = await core.handlers['block:create'](
      { intentId: 'intent-mock-1', request: { ...youtubeRequest(), reason: 'Quiero aprobar' } },
      ctx,
    );
    expect(created.ok).toBe(true);
    await run(clock, 1_000);
    expect(notifier.shown.map((n) => n.title)).toEqual(['Bloqueo iniciado']);
    expect(core.getSnapshot().prefs.lastReason).toBe('Quiero aprobar');

    const blockId = created.ok ? created.value.blockId : 'blk_x';
    const before = Date.parse(core.getSnapshot().state?.blocks[0]?.endsAt ?? '');
    const ext = await core.handlers['block:extend']({ blockId, addMinutes: 30 }, ctx);
    expect(ext.ok).toBe(true);
    await run(clock, 5_000);
    const endsAt = Date.parse(core.getSnapshot().state?.blocks[0]?.endsAt ?? '');
    expect(endsAt - before).toBe(30 * 60_000);

    // A waiting extension is still sent when quitting.
    const ext2 = await core.handlers['block:extend']({ blockId, addMinutes: 15 }, ctx);
    expect(ext2.ok).toBe(true);

    const diag = await core.handlers['diagnostics:copy'](null, ctx);
    expect(diag).toEqual({ ok: true, value: { source: 'guardian' } });
    expect(host.clipboard[0]).toContain('/v1/diagnostics');
    expect(host.clipboard[0]).not.toContain('Quiero aprobar');

    const wrong = await core.handlers['data:delete']({ intentId: 'del-1', confirm: 'borra' }, ctx);
    expect(wrong).toMatchObject({ ok: false, error: { code: 'confirm_word_mismatch' } });
    const deleted = await core.handlers['data:delete']({ intentId: 'del-2', confirm: 'BORRAR' }, ctx);
    expect(deleted.ok).toBe(true);
    expect(core.getSnapshot().prefs.lastReason).toBe('');
    expect(core.getSnapshot().templates.map((t) => t.id)).toEqual(['deberes', 'examen', 'leer']);

    const shutdown = core.shutdown(1_500);
    await settle(30);
    await shutdown;
    // The +15 still waiting in the undo queue was sent on «Salir».
    const after = Date.parse(core.getSnapshot().state?.blocks[0]?.endsAt ?? '');
    expect(after - before).toBe(45 * 60_000);
    expect(core.getSnapshot().ops.extendQueue).toHaveLength(0);
    cores.splice(cores.indexOf(core), 1);
  });
});
