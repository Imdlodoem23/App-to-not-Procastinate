import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUARDIAN_CAPABILITIES } from '@centrate/shared/guardian-api';
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
import { FEATURES } from '../../../src/shared/features';
import {
  HARNESS_NOW,
  harnessFixture,
  makeHealth,
  type HarnessFixture,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { hostStub, settle } from './helpers';

const ctx = { window: 'main' as const };
const MIN = 60_000;
const dirs: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown(0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function options(patch: Partial<CoreOptions>): CoreOptions {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-core-awake-'));
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

function harnessCore(id: HarnessStateId, edit?: (f: HarnessFixture) => HarnessFixture) {
  const base = harnessFixture(id);
  const fixture = edit ? edit(base) : base;
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
    const step = Math.min(left, 1_000);
    core.harness?.advance(step);
    left -= step;
  }
  await settle();
}

function writes(t: ReturnType<typeof harnessCore>): unknown[] {
  return t.harness
    .guardianCalls()
    .filter((c) => c.method === 'setKeepAwake')
    .map((c) => c.body);
}

describe('core: «Mantener despierto»', () => {
  it('turns it on with the whole configuration and shows it before the next poll', async () => {
    const t = harnessCore('idle');
    t.core.start();
    await settle();
    const r = await t.core.handlers['keep-awake:set'](
      { change: { on: true, durationMinutes: 60 } },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value).toMatchObject({ on: true, durationMinutes: 60, display: true, active: true });
    expect(Date.parse(r.value.until ?? '')).toBe(HARNESS_NOW + 60 * MIN);
    // Read first, then one full PUT (display kept from the guardian's configuration).
    const methods = t.harness.guardianCalls().map((c) => c.method);
    expect(methods.indexOf('getKeepAwake')).toBeLessThan(methods.indexOf('setKeepAwake'));
    expect(writes(t)).toEqual([{ on: true, durationMinutes: 60, display: true }]);
    expect(t.core.getSnapshot().state?.keepAwake?.on).toBe(true);
  });

  it('sends nothing when the choice is the running one (the countdown keeps going)', async () => {
    const t = harnessCore('keep-awake-until');
    t.core.start();
    await settle();
    const until = t.core.getSnapshot().state?.keepAwake?.until;
    const r = await t.core.handlers['keep-awake:set'](
      { change: { on: true, durationMinutes: 120 } },
      ctx,
    );
    expect(r.ok && r.value.until).toBe(until);
    expect(writes(t)).toEqual([]);
  });

  it('changes only the field asked for and turns it off', async () => {
    const t = harnessCore('keep-awake-until');
    t.core.start();
    await settle();
    await t.core.handlers['keep-awake:set']({ change: { display: false } }, ctx);
    const off = await t.core.handlers['keep-awake:set']({ change: { on: false } }, ctx);
    expect(off.ok && off.value).toMatchObject({ on: false, durationMinutes: 120, since: null });
    expect(writes(t)).toEqual([
      { on: true, durationMinutes: 120, display: false },
      { on: false, durationMinutes: 120, display: false },
    ]);
    await advance(t.core, 2_500);
    expect(t.core.getSnapshot().state?.keepAwake).toMatchObject({ on: false, display: false });
  });

  it('refuses a bad change, or a guardian without the capability, without writing', async () => {
    const t = harnessCore('idle');
    const bad = await t.core.handlers['keep-awake:set'](
      { change: { durationMinutes: 3 } },
      ctx,
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation_failed' } });

    const older = harnessCore('idle', (f) => {
      const health = makeHealth(HARNESS_NOW, {
        capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'keep_awake'),
      });
      return {
        ...f,
        snapshot: { ...f.snapshot, health },
        fake: { ...f.fake, health },
      };
    });
    const r = await older.core.handlers['keep-awake:set']({ change: { on: true } }, ctx);
    expect(r).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(older.harness.guardianCalls().some((c) => c.method === 'getKeepAwake')).toBe(false);
    expect(writes(t)).toEqual([]);
  });

  it('says «Ya no se mantiene despierto» when its end passes', async () => {
    const t = harnessCore('keep-awake-until');
    t.core.start();
    await advance(t.core, 2_000);
    // Started 30 min ago for 2 h: 90 min left.
    await advance(t.core, 90 * MIN);
    await advance(t.core, 3_000);
    expect(t.core.getSnapshot().state?.keepAwake?.on).toBe(false);
    const shown = t.harness.notifications();
    expect(shown.some((n) => n.title === 'Ya no se mantiene despierto')).toBe(true);
  });
});
