import type { UsageReportRequest, UsageReportResponse } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import {
  UsageReporter,
  reportIntervalMs,
  usageItems,
  type ForegroundProcess,
} from '../../../src/main/usage/reporter';
import { HARNESS_NOW, makeGuardianState, makeLimits } from '../../../src/shared/fixtures';

function setup(
  options: { idleSeconds?: () => number; locked?: () => boolean; fail?: boolean } = {},
) {
  const clock = createManualClock(HARNESS_NOW);
  const start = clock.now();
  let front: ForegroundProcess = 'Discord';
  const sent: UsageReportRequest[] = [];
  let fail = options.fail ?? false;
  let remaining = 1_500;
  const reporter = new UsageReporter({
    clock,
    monotonic: () => clock.now() - start,
    readProcess: async () => front,
    idle: {
      idleSeconds: options.idleSeconds ?? (() => 0),
      locked: options.locked ?? (() => false),
    },
    report: async (body): Promise<UsageReportResponse> => {
      sent.push(body);
      if (fail) throw new Error('down');
      return {
        day: '2026-09-28',
        limits: [
          {
            limitId: 'lim_fixture0000000001',
            usedTodaySeconds: 0,
            remainingTodaySeconds: remaining,
            appliesToday: true,
            creditedSeconds: 10,
            blockedUntil: null,
          },
        ],
        serverNow: new Date(clock.now()).toISOString(),
      };
    },
    log: () => undefined,
  });
  return {
    clock,
    reporter,
    sent,
    setFront: (p: ForegroundProcess) => {
      front = p;
    },
    setFail: (f: boolean) => {
      fail = f;
    },
    setRemaining: (r: number) => {
      remaining = r;
    },
  };
}

/** Advance one second at a time, letting each sample's promise settle. */
async function seconds(clock: ReturnType<typeof createManualClock>, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    clock.advance(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const withLimit = makeGuardianState(HARNESS_NOW, { limits: makeLimits(HARNESS_NOW) });
const noLimit = makeGuardianState(HARNESS_NOW);

describe('UsageReporter', () => {
  it('samples only while a limit exists, the link is up and the guardian can take it', () => {
    const { reporter } = setup();
    reporter.sync(noLimit, true, true);
    expect(reporter.active()).toBe(false);
    reporter.sync(withLimit, false, true);
    expect(reporter.active()).toBe(false);
    reporter.sync(withLimit, true, false);
    expect(reporter.active()).toBe(false);
    reporter.sync(withLimit, true, true);
    expect(reporter.active()).toBe(true);
    reporter.sync(noLimit, true, true);
    expect(reporter.active()).toBe(false);
  });

  it('counts the foreground process once a second and reports every 30 s', async () => {
    const { clock, reporter, sent, setFront } = setup();
    reporter.sync(withLimit, true, true);
    await seconds(clock, 10);
    setFront('code');
    await seconds(clock, 5);
    expect(sent).toHaveLength(0);
    await seconds(clock, 16);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.intervalMs).toBeGreaterThanOrEqual(30_000);
    expect(sent[0]?.items).toEqual([
      { type: 'process', value: 'code', seconds: expect.any(Number) },
      { type: 'process', value: 'Discord', seconds: 10 },
    ]);
    // Never a window title: only process names.
    expect(JSON.stringify(sent)).not.toMatch(/title/i);
  });

  it('counts nothing while idle or locked', async () => {
    let idle = 120;
    const { clock, reporter, sent } = setup({ idleSeconds: () => idle });
    reporter.sync(withLimit, true, true);
    await seconds(clock, 40);
    expect(sent).toHaveLength(0);
    expect(reporter.pending().size).toBe(0);
    idle = 5;
    await seconds(clock, 3);
    expect(reporter.pending().get('Discord')).toBeGreaterThanOrEqual(2);
  });

  it('never retries: a failed report’s seconds join the next one, a whole interval later', async () => {
    const { clock, reporter, sent, setFail } = setup({ fail: true });
    reporter.sync(withLimit, true, true);
    await seconds(clock, 31);
    expect(sent).toHaveLength(1);
    await seconds(clock, 10);
    expect(sent).toHaveLength(1);
    setFail(false);
    await seconds(clock, 25);
    expect(sent).toHaveLength(2);
    const last = sent[1];
    expect(last?.items[0]?.seconds).toBeGreaterThan(50);
    expect(last?.items[0]?.seconds).toBeLessThanOrEqual(Math.ceil((last?.intervalMs ?? 0) / 1000));
  });

  it('reports every 5 s while a limit it counts toward has less than 30 s left', async () => {
    const { clock, reporter, sent, setRemaining } = setup();
    setRemaining(20);
    reporter.sync(withLimit, true, true);
    await seconds(clock, 31);
    expect(sent).toHaveLength(1);
    await seconds(clock, 6);
    expect(sent).toHaveLength(2);
  });

  it('stops for good where the foreground cannot be read', async () => {
    const { clock, reporter, setFront } = setup();
    setFront('unsupported');
    reporter.sync(withLimit, true, true);
    await seconds(clock, 2);
    expect(reporter.active()).toBe(false);
    reporter.sync(withLimit, true, true);
    expect(reporter.active()).toBe(false);
  });
});

describe('usage report helpers', () => {
  it('caps items at the interval and at usageMaxItems, most used first', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 40; i += 1) counts.set(`app${i}`, i + 1);
    counts.set('big', 500);
    const items = usageItems(counts, 30_000);
    expect(items).toHaveLength(32);
    expect(items[0]).toEqual({ type: 'process', value: 'big', seconds: 30 });
  });

  it('picks the fast cadence only near the end of an allowance it counted toward', () => {
    const base = {
      limitId: 'lim_fixture0000000001' as const,
      usedTodaySeconds: 0,
      appliesToday: true,
      blockedUntil: null,
    };
    const answer = (remaining: number, credited: number): UsageReportResponse => ({
      day: '2026-09-28',
      limits: [{ ...base, remainingTodaySeconds: remaining, creditedSeconds: credited }],
      serverNow: new Date(HARNESS_NOW).toISOString(),
    });
    expect(reportIntervalMs(null)).toBe(30_000);
    expect(reportIntervalMs(answer(20, 5))).toBe(5_000);
    expect(reportIntervalMs(answer(20, 0))).toBe(30_000);
    expect(reportIntervalMs(answer(0, 5))).toBe(30_000);
    expect(reportIntervalMs(answer(600, 5))).toBe(30_000);
  });
});
