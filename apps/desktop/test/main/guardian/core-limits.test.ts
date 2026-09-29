import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyTargets, type DailyLimitInput } from '@centrate/shared/guardian-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
}));

import type { Core, CoreOptions, LimitAlert } from '../../../src/main/contracts';
import { createCore } from '../../../src/main/guardian/core';
import { createManualClock } from '../../../src/main/guardian/clock';
import { createMemoryLogger } from '../../../src/main/logs/logger';
import { FEATURES } from '../../../src/shared/features';
import { HARNESS_NOW, harnessFixture, type HarnessStateId } from '../../../src/shared/fixtures';
import { hostStub, settle } from './helpers';

const ctx = { window: 'main' as const };
const dirs: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown(0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function options(patch: Partial<CoreOptions>): CoreOptions {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-core-limits-'));
  dirs.push(dir);
  return {
    platform: 'linux',
    appVersion: '0.1.0',
    packaged: false,
    userDataDir: dir,
    sysDir: '/nonexistent/centrate',
    guardianBinary: null,
    clock: createManualClock(HARNESS_NOW),
    features: FEATURES,
    harness: null,
    host: hostStub(),
    ...patch,
  };
}

function harnessCore(id: HarnessStateId) {
  const fixture = harnessFixture(id);
  const core = createCore(options({ harness: fixture }), {
    logger: createMemoryLogger(),
    exec: async () => ({ code: 1, stdout: '', stderr: '', error: null }),
  });
  cores.push(core);
  const harness = core.harness;
  if (!harness) throw new Error('no harness');
  return { fixture, core, harness };
}

async function advance(core: Core, ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    await settle();
    const step = Math.min(left, 100);
    core.harness?.advance(step);
    left -= step;
  }
  await settle();
}

function input(patch: Partial<DailyLimitInput> = {}): DailyLimitInput {
  return {
    name: 'YouTube',
    enabled: true,
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    dailyMinutes: 30,
    days: [1, 2, 3, 4, 5, 6, 7],
    mode: 'strict',
    reason: '',
    acknowledgeNoEmergency: false,
    ...patch,
  };
}

describe('core: daily limits', () => {
  it('lists, creates (one key), edits and asks to delete through the guardian', async () => {
    const t = harnessCore('limit-confirm');
    t.core.start();
    await settle();
    const list = await t.core.handlers['limits:list'](null, ctx);
    expect(list.ok && list.value.map((l) => l.name)).toEqual(['Redes sociales', 'TikTok']);

    const created = await t.core.handlers['limits:create'](
      { intentId: 'intent-limit-1', input: input() },
      ctx,
    );
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value).toMatchObject({ name: 'YouTube', dailyMinutes: 30, pendingChange: null });
    const call = t.harness.guardianCalls().find((c) => c.method === 'createLimit');
    expect(call?.idempotencyKey).toBe('intent-limit-1');

    const softer = await t.core.handlers['limits:update'](
      { id: created.value.id, input: input({ dailyMinutes: 60 }) },
      ctx,
    );
    expect(softer.ok && softer.value.pendingChange?.definition?.dailyMinutes).toBe(60);

    const removed = await t.core.handlers['limits:delete']({ id: created.value.id }, ctx);
    expect(removed.ok && removed.value.pendingChange?.definition).toBeNull();

    // The state catches up after the write.
    await advance(t.core, 2_500);
    expect(t.core.getSnapshot().state?.limits?.map((l) => l.name)).toContain('YouTube');
  });

  it('refuses a malformed request without calling the guardian', async () => {
    const t = harnessCore('limit-confirm');
    const r = await t.core.handlers['limits:create'](
      { intentId: 'intent-limit-2', input: input({ dailyMinutes: 1 }) },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(t.harness.guardianCalls().some((c) => c.method === 'createLimit')).toBe(false);
  });

  it('turns a fresh limit_warning into an OSD alert', async () => {
    const t = harnessCore('limit-confirm');
    const alerts: LimitAlert[] = [];
    const off = t.core.onLimitAlert((a) => alerts.push(a));
    t.core.start();
    await advance(t.core, 1_000);
    // A 5-minute allowance warns at once.
    const r = await t.core.handlers['limits:create'](
      { intentId: 'intent-limit-3', input: input({ dailyMinutes: 5 }) },
      ctx,
    );
    expect(r.ok).toBe(true);
    await advance(t.core, 3_000);
    expect(alerts).toEqual([{ kind: 'warning', text: 'Te quedan 5 min de YouTube hoy' }]);
    off();
  });
});
