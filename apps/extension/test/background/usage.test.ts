// Daily-limit usage (src/background/usage.ts, docs/ARCHITECTURE.md §10.13): what counts,
// how reports are built, never retried and never beyond real time, the incognito
// instance's totals and the badge.
import { describe, expect, it } from 'vitest';
import { colors } from '@centrate/shared/design/tokens';
import type {
  ExtRuleLimit,
  UsageReportRequest,
  UsageReportResponse,
} from '@centrate/shared/guardian-api';
import { GUARDIAN_LIMITS, isUsageReportRequest } from '@centrate/shared/guardian-api';
import type { BadgeSpec, PendingUsage, UsageEnv } from '../../src/background/usage';
import {
  FLUSH_MS,
  MAX_SEGMENT_MS,
  USAGE_KEYS,
  badgeFor,
  countedHost,
  createUsageTracker,
  creditPending,
  incognitoDelta,
  limitLeftFor,
  limitsForHost,
  nextReportAt,
  parseUsageState,
  parseUsageStatus,
  planReport,
  subtractSent,
  trimPending,
} from '../../src/background/usage';
import type { UsageReportOutcome } from '../../src/background/state';
import { withPagesLocale } from '../../src/pages/i18n';
import { NOW, memoryArea } from './fakes';

const LIM_YT = 'lim_0123456789abcdefYTYT' as const;
const LIM_SOCIAL = 'lim_0123456789abcdefSOCI' as const;
const SEC = 1_000;

const YOUTUBE: ExtRuleLimit = {
  id: LIM_YT,
  name: 'YouTube',
  serviceIds: ['youtube'],
  domains: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  excludedDomains: ['accounts.youtube.com'],
  dailyMinutes: 30,
  appliesToday: true,
};

const SOCIAL: ExtRuleLimit = {
  id: LIM_SOCIAL,
  name: 'Redes sociales',
  serviceIds: ['instagram'],
  domains: ['instagram.com', 'www.instagram.com'],
  excludedDomains: [],
  dailyMinutes: 60,
  appliesToday: true,
};

const env = (url: string | null, over: Partial<UsageEnv> = {}): UsageEnv => ({
  focused: true,
  tab: url === null ? null : { id: 7, url, audible: false },
  idle: 'active',
  ...over,
});

function answer(
  remaining: Record<string, number>,
  over: Partial<UsageReportResponse['limits'][number]> = {},
): UsageReportResponse {
  return {
    day: '2026-09-28',
    limits: Object.entries(remaining).map(([limitId, seconds]) => ({
      limitId: limitId as typeof LIM_YT,
      usedTodaySeconds: 1_800 - seconds,
      remainingTodaySeconds: seconds,
      appliesToday: true,
      creditedSeconds: 0,
      blockedUntil: null,
      ...over,
    })),
    serverNow: new Date(NOW).toISOString(),
  };
}

describe('what counts', () => {
  it('matches a limit by its domains and subdomains, never its excluded hosts', () => {
    expect(limitsForHost([YOUTUBE, SOCIAL], 'www.youtube.com')).toEqual([YOUTUBE]);
    expect(limitsForHost([YOUTUBE, SOCIAL], 'music.youtube.com')).toEqual([YOUTUBE]);
    expect(limitsForHost([YOUTUBE], 'accounts.youtube.com')).toEqual([]);
    expect(limitsForHost([YOUTUBE], 'notyoutube.com')).toEqual([]);
  });

  it('counts the focused active tab while the user is active or the tab plays sound', () => {
    const limits = [YOUTUBE];
    const yt = 'https://www.youtube.com/watch?v=1';
    expect(countedHost(env(yt), limits)).toBe('www.youtube.com');
    expect(countedHost(env('https://WWW.YouTube.com./x'), limits)).toBe('www.youtube.com');
    expect(countedHost(env(yt, { focused: false }), limits)).toBeNull();
    expect(countedHost(env(yt, { idle: 'idle' }), limits)).toBeNull();
    expect(
      countedHost(env(yt, { idle: 'idle', tab: { id: 7, url: yt, audible: true } }), limits),
    ).toBe('www.youtube.com');
    // Locked never counts, sound or not.
    expect(
      countedHost(env(yt, { idle: 'locked', tab: { id: 7, url: yt, audible: true } }), limits),
    ).toBeNull();
    expect(countedHost(env('https://example.com/'), limits)).toBeNull();
    expect(countedHost(env('chrome-extension://x/blocked.html'), limits)).toBeNull();
    expect(countedHost(env(null), limits)).toBeNull();
    expect(countedHost(env(yt), [])).toBeNull();
  });
});

describe('pending seconds and report plans', () => {
  it('keeps hosts in order of their last credit and trims the oldest first', () => {
    let pending: PendingUsage = [];
    pending = creditPending(pending, 'www.youtube.com', 50 * SEC);
    pending = creditPending(pending, 'www.instagram.com', 40 * SEC);
    pending = creditPending(pending, 'www.youtube.com', 50 * SEC);
    expect(pending).toEqual([
      ['www.instagram.com', 40 * SEC],
      ['www.youtube.com', 100 * SEC],
    ]);
    expect(trimPending(pending)).toEqual([
      ['www.instagram.com', 20 * SEC],
      ['www.youtube.com', 100 * SEC],
    ]);
    const many: PendingUsage = Array.from({ length: 40 }, (_, i) => [`s${i}.example.com`, SEC]);
    const kept = trimPending(many);
    expect(kept).toHaveLength(GUARDIAN_LIMITS.usageMaxItems);
    expect(kept.at(-1)).toEqual(['s39.example.com', SEC]);
  });

  it('reports whole seconds over the span since the last report, within the API limits', () => {
    const pending: PendingUsage = [
      ['www.instagram.com', 9_500],
      ['www.youtube.com', 20_700],
      ['m.youtube.com', 400],
    ];
    const plan = planReport(pending, NOW - 40 * SEC, NOW);
    expect(plan?.body).toEqual({
      intervalMs: 40_000,
      items: [
        { type: 'domain', value: 'www.instagram.com', seconds: 9 },
        { type: 'domain', value: 'www.youtube.com', seconds: 20 },
      ],
    });
    expect(isUsageReportRequest(plan?.body)).toBe(true);
    // The remainders stay pending after a success.
    expect(subtractSent(pending, plan?.sent ?? [])).toEqual([
      ['www.instagram.com', 500],
      ['www.youtube.com', 700],
      ['m.youtube.com', 400],
    ]);
  });

  it('never covers more than the maximum interval: older seconds are dropped', () => {
    const plan = planReport([['www.youtube.com', 300 * SEC]], NOW - 10 * 60_000, NOW);
    expect(plan?.body).toEqual({
      intervalMs: GUARDIAN_LIMITS.usageMaxIntervalMs,
      items: [{ type: 'domain', value: 'www.youtube.com', seconds: 120 }],
    });
    expect(isUsageReportRequest(plan?.body)).toBe(true);
    // Nothing to say: under a second, or a span under a second.
    expect(planReport([['www.youtube.com', 999]], NOW - 30 * SEC, NOW)).toBeNull();
    expect(planReport([['www.youtube.com', 5 * SEC]], NOW - 500, NOW)).toBeNull();
    expect(planReport([['www.youtube.com', 5 * SEC]], null, NOW)).toBeNull();
  });

  it('waits a full interval after any attempt, 5 s near the end of an allowance', () => {
    const pending: PendingUsage = [['www.youtube.com', 3 * SEC]];
    const base = { pending, windowStart: NOW - 60 * SEC };
    expect(nextReportAt({ ...base, lastAttemptAt: null, fast: false })).toBe(NOW - 59 * SEC);
    expect(nextReportAt({ ...base, lastAttemptAt: NOW, fast: false })).toBe(NOW + 30 * SEC);
    expect(nextReportAt({ ...base, lastAttemptAt: NOW, fast: true })).toBe(NOW + 5 * SEC);
    expect(nextReportAt({ ...base, pending: [], lastAttemptAt: null, fast: true })).toBeNull();
    // Fractions of several hosts are not a report (items carry whole seconds).
    const fractions: PendingUsage = [
      ['www.youtube.com', 600],
      ['m.youtube.com', 600],
    ];
    expect(
      nextReportAt({ ...base, pending: fractions, lastAttemptAt: null, fast: true }),
    ).toBeNull();
  });

  it('folds what grew in the incognito totals (a total that shrank starts over)', () => {
    expect(
      incognitoDelta(
        { 'www.youtube.com': 50 * SEC, 'www.instagram.com': 5 * SEC, 'm.youtube.com': SEC },
        { 'www.youtube.com': 20 * SEC, 'www.instagram.com': 9 * SEC, 'm.youtube.com': SEC },
      ),
    ).toEqual([
      ['www.youtube.com', 30 * SEC],
      ['www.instagram.com', 5 * SEC],
    ]);
  });

  it('reads stored records defensively', () => {
    expect(parseUsageState({ v: 1, pending: [['not a host', 5]] }).pending).toEqual([]);
    expect(parseUsageState('x').segment).toBeNull();
    expect(parseUsageStatus({ v: 1, at: NOW, day: 'today', limits: [] })).toBeNull();
    expect(parseUsageStatus({ v: 1, at: NOW, ...answer({ [LIM_YT]: 60 }) })?.limits).toHaveLength(
      1,
    );
  });
});

describe('badge', () => {
  const status = (remaining: number, over = {}) => ({
    v: 1 as const,
    at: NOW,
    ...answer({ [LIM_YT]: remaining }, over),
  });

  it('shows the minutes left minus what is not reported yet, orange for the last 5', () => {
    const left = limitLeftFor('www.youtube.com', [YOUTUBE], status(12 * 60), [
      ['www.youtube.com', 50 * SEC],
      ['www.instagram.com', 500 * SEC],
    ]);
    expect(left).toEqual({ limit: YOUTUBE, seconds: 12 * 60 - 50 });
    expect(badgeFor(left)).toEqual({
      text: '12m',
      title: 'Te quedan 12 min de YouTube hoy',
      color: colors.light.blue,
    } satisfies BadgeSpec);
    expect(badgeFor({ limit: YOUTUBE, seconds: 5 * 60 })).toMatchObject({
      text: '5m',
      color: colors.light.orange,
    });
    expect(badgeFor({ limit: YOUTUBE, seconds: 150 * 60 })?.text).toBe('3h');
    withPagesLocale('en', () => {
      expect(badgeFor({ limit: YOUTUBE, seconds: 59 })?.title).toBe('1 min of YouTube left today');
    });
  });

  it('shows nothing without an answer, on a day the limit does not apply or once blocked', () => {
    expect(limitLeftFor('www.youtube.com', [YOUTUBE], null, [])).toBeNull();
    expect(
      limitLeftFor('www.youtube.com', [YOUTUBE], status(600, { appliesToday: false }), []),
    ).toBeNull();
    expect(
      limitLeftFor(
        'www.youtube.com',
        [YOUTUBE],
        status(0, { blockedUntil: '2026-09-28T22:00:00.000Z' }),
        [],
      ),
    ).toBeNull();
    expect(badgeFor(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------

function harness(
  options: { role?: 'main' | 'follower'; local?: ReturnType<typeof memoryArea> } = {},
) {
  const clock = { now: NOW };
  const state = {
    env: env('https://www.youtube.com/watch?v=1'),
    limits: [YOUTUBE, SOCIAL] as ExtRuleLimit[],
    answer: answer({ [LIM_YT]: 20 * 60, [LIM_SOCIAL]: 60 * 60 }) as UsageReportOutcome,
  };
  const reports: UsageReportRequest[] = [];
  const badges: Array<[number, BadgeSpec | null]> = [];
  const timers: number[] = [];
  const session = memoryArea();
  const local = options.local ?? memoryArea();
  const tracker = createUsageTracker({
    role: options.role ?? 'main',
    now: () => clock.now,
    getLimits: async () => state.limits,
    readEnv: async () => state.env,
    report: async (body) => {
      reports.push(body);
      return state.answer;
    },
    session,
    local,
    badge: {
      set: async (tabId, badge) => {
        badges.push([tabId, badge]);
      },
    },
    setTimer: (_fn, ms) => {
      timers.push(ms);
      return timers.length;
    },
    clearTimer: () => undefined,
    warn: () => undefined,
  });
  const at = async (ms: number, what: 'update' | 'tick' = 'tick'): Promise<void> => {
    clock.now = NOW + ms;
    await tracker[what]();
    await tracker.idle();
  };
  const stored = async () =>
    parseUsageState((await session.get([USAGE_KEYS.state]))[USAGE_KEYS.state]);
  return { clock, state, reports, badges, timers, session, local, tracker, at, stored };
}

describe('usage tracker (main instance)', () => {
  it('counts the focused tab and reports it with the span since the last report', async () => {
    const h = harness();
    await h.at(0, 'update');
    expect((await h.stored()).segment).toEqual({ host: 'www.youtube.com', since: NOW });
    // No answer yet: the first report goes out fast (5 s), for the badge.
    await h.at(5 * SEC);
    expect(h.reports).toEqual([
      { intervalMs: 5_000, items: [{ type: 'domain', value: 'www.youtube.com', seconds: 5 }] },
    ]);
    expect((await h.stored()).pending).toEqual([]);

    // Then every 30 s while there are seconds to report.
    await h.at(20 * SEC);
    expect(h.reports).toHaveLength(1);
    await h.at(35 * SEC);
    expect(h.reports[1]).toEqual({
      intervalMs: 30_000,
      items: [{ type: 'domain', value: 'www.youtube.com', seconds: 30 }],
    });
    for (const body of h.reports) expect(isUsageReportRequest(body)).toBe(true);
  });

  it('stops counting when the window loses focus or the user goes idle without sound', async () => {
    const h = harness();
    await h.at(0, 'update');
    h.state.env = env('https://www.youtube.com/', { focused: false });
    await h.at(10 * SEC, 'update');
    await h.at(60 * SEC);
    h.state.env = env('https://www.youtube.com/', { idle: 'idle' });
    await h.at(70 * SEC, 'update');
    await h.at(200 * SEC);
    const total = h.reports.flatMap((r) => r.items).reduce((s, i) => s + i.seconds, 0);
    expect(total).toBe(10);

    // A video playing while the user just watches keeps counting.
    h.state.env = env(null, {
      idle: 'idle',
      tab: { id: 7, url: 'https://www.youtube.com/watch?v=2', audible: true },
    });
    await h.at(300 * SEC, 'update');
    await h.at(340 * SEC);
    expect(h.reports.at(-1)?.items).toEqual([
      { type: 'domain', value: 'www.youtube.com', seconds: 40 },
    ]);
  });

  it('never retries a refused report: its seconds go with the next one', async () => {
    const h = harness();
    await h.at(0, 'update');
    await h.at(5 * SEC); // first answer
    h.state.answer = 'refused'; // an error status: nothing was credited
    await h.at(35 * SEC);
    expect(h.reports).toHaveLength(2);
    await h.at(40 * SEC);
    await h.at(60 * SEC);
    expect(h.reports).toHaveLength(2); // not retried before a full interval
    h.state.answer = answer({ [LIM_YT]: 600 });
    await h.at(65 * SEC);
    expect(h.reports).toHaveLength(3);
    expect(h.reports[2]).toEqual({
      intervalMs: 60_000,
      items: [{ type: 'domain', value: 'www.youtube.com', seconds: 60 }],
    });
  });

  it('drops the seconds of a report whose answer was lost (it may have been credited)', async () => {
    const h = harness();
    await h.at(0, 'update');
    await h.at(5 * SEC); // first answer
    h.state.answer = 'lost';
    await h.at(35 * SEC);
    expect(h.reports).toHaveLength(2);
    expect((await h.stored()).pending).toEqual([]);
    h.state.answer = answer({ [LIM_YT]: 600 });
    await h.at(65 * SEC);
    expect(h.reports).toHaveLength(3);
    expect(h.reports[2]).toEqual({
      intervalMs: 30_000,
      items: [{ type: 'domain', value: 'www.youtube.com', seconds: 30 }],
    });
  });

  it('never credits more than MAX_SEGMENT_MS for a gap without events (a sleeping computer)', async () => {
    const h = harness();
    await h.at(0, 'update');
    await h.at(5 * SEC);
    await h.at(5 * SEC + 3 * 3_600_000);
    const last = h.reports.at(-1);
    expect(last?.items[0]?.seconds).toBe(MAX_SEGMENT_MS / SEC);
    expect(last?.intervalMs).toBe(GUARDIAN_LIMITS.usageMaxIntervalMs);
  });

  it('reports every 5 s when less than 30 s are left', async () => {
    const h = harness();
    h.state.answer = answer({ [LIM_YT]: 34 });
    await h.at(0, 'update');
    await h.at(5 * SEC);
    h.state.answer = answer({ [LIM_YT]: 24 });
    await h.at(10 * SEC); // 34 s left minus 5 s unreported: fast
    await h.at(15 * SEC);
    await h.at(20 * SEC);
    expect(h.reports.map((r) => r.intervalMs)).toEqual([5_000, 5_000, 5_000, 5_000]);
    // The next timer is the fast one.
    expect(h.timers.at(-1)).toBeLessThanOrEqual(5_000);
  });

  it('keeps a timer while a segment is open, and none when nothing counts', async () => {
    const h = harness();
    await h.at(0, 'update');
    expect(h.timers.at(-1)).toBeLessThanOrEqual(FLUSH_MS);
    h.state.env = env('https://example.com/');
    await h.at(8 * SEC, 'update');
    await h.at(8 * SEC + 30 * SEC);
    const count = h.timers.length;
    await h.at(200 * SEC);
    expect(h.timers.length).toBe(count);
  });

  it('reports nothing (and forgets its seconds) once the rules carry no limits', async () => {
    const h = harness();
    await h.at(0, 'update');
    await h.at(3 * SEC);
    const before = h.reports.length;
    await h.at(4 * SEC);
    h.state.limits = [];
    await h.at(4 * SEC + 600, 'update');
    await h.at(120 * SEC);
    expect(h.reports).toHaveLength(before);
    expect(await h.stored()).toMatchObject({ segment: null, pending: [] });
  });

  it('shows the minutes left on the tab and clears the badge when it leaves the site', async () => {
    const h = harness();
    h.state.answer = answer({ [LIM_YT]: 12 * 60 - 5 });
    await h.at(0, 'update');
    await h.at(5 * SEC);
    expect(h.badges.at(-1)).toEqual([
      7,
      { text: '12m', title: 'Te quedan 12 min de YouTube hoy', color: colors.light.blue },
    ]);
    h.state.env = env('https://example.com/');
    await h.at(6 * SEC, 'update');
    expect(h.badges.at(-1)).toEqual([7, null]);
  });
});

describe('Chromium incognito instance (split mode)', () => {
  it('counts into the shared totals and never reports; the main instance does', async () => {
    const local = memoryArea();
    const incognito = harness({ role: 'follower', local });
    const main = harness({ local });
    main.state.env = env('https://example.com/', { focused: false });

    await incognito.at(0, 'update');
    await incognito.at(15 * SEC);
    await incognito.at(20 * SEC);
    expect(incognito.reports).toEqual([]);
    expect(local.data.get(USAGE_KEYS.incognitoTotals)).toMatchObject({
      totals: { 'www.youtube.com': 20 * SEC },
    });

    await main.at(21 * SEC, 'update');
    expect(main.reports).toEqual([
      { intervalMs: 20_000, items: [{ type: 'domain', value: 'www.youtube.com', seconds: 20 }] },
    ]);
    // Folded once: the same totals are not reported again.
    await main.at(200 * SEC);
    expect(main.reports).toHaveLength(1);
    await incognito.at(30 * SEC);
    await main.at(240 * SEC);
    expect(main.reports.at(-1)?.items).toEqual([
      { type: 'domain', value: 'www.youtube.com', seconds: 10 },
    ]);
  });

  it('credits nothing for a segment left by an instance that stopped', async () => {
    const local = memoryArea();
    const incognito = harness({ role: 'follower', local });
    await incognito.at(0, 'update');
    await incognito.at(10 * SEC);
    // The incognito instance goes away with its segment open; days later it starts again.
    await incognito.at(3 * 86_400_000, 'update');
    expect(local.data.get(USAGE_KEYS.incognitoTotals)).toMatchObject({
      totals: { 'www.youtube.com': 10 * SEC },
    });
  });
});
