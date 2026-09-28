import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptResponse, ExtRulesResponse } from '@centrate/shared/guardian-api';
import type {
  AttemptTracker,
  CommitDetails,
  TabLike,
  TabsApi,
} from '../../src/background/attempts';
import {
  BLOCKED_PAGE_FOLLOW_MS,
  CLIENT_DUPLICATE_MS,
  NAV_MATCH_MS,
  createAttemptTracker,
  decideReport,
  installAttemptListeners,
  isBlockedInfoRequest,
  isTopLevelActive,
  memoryTabStore,
} from '../../src/background/attempts';
import { BLOCKED_INFO_MESSAGE } from '../../src/background/rules';
import { backgroundPlugins } from '../../src/background/state';
import {
  BLK_CUSTOM,
  BLK_EXAM,
  BLK_YT,
  MIN,
  NOW,
  attemptResponse,
  blockRules,
  examRules,
  iso,
} from './enforcement-fixtures';

const BASE = 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah/';
const PAGE = `${BASE}blocked.html?cause=domain&service=youtube`;

describe('isTopLevelActive', () => {
  const nav = { tabId: 3, frameId: 0, url: 'https://www.youtube.com/' };
  it('accepts active top-level navigations (Chrome fields or none, as in Firefox)', () => {
    expect(isTopLevelActive(nav)).toBe(true);
    expect(
      isTopLevelActive({ ...nav, frameType: 'outermost_frame', documentLifecycle: 'active' }),
    ).toBe(true);
  });
  it('rejects prerenders, cached pages, sub-frames, fenced frames and tab-less loads', () => {
    expect(isTopLevelActive({ ...nav, documentLifecycle: 'prerender' })).toBe(false);
    expect(isTopLevelActive({ ...nav, documentLifecycle: 'cached' })).toBe(false);
    expect(isTopLevelActive({ ...nav, frameId: 4, frameType: 'sub_frame' })).toBe(false);
    expect(isTopLevelActive({ ...nav, frameType: 'fenced_frame' })).toBe(false);
    expect(isTopLevelActive({ ...nav, tabId: -1 })).toBe(false);
  });
});

describe('decideReport', () => {
  const at = NOW;
  it('reports new navigations', () => {
    expect(decideReport({ transitionType: 'typed', now: at })).toBe('report');
    expect(
      decideReport({
        transitionType: 'link',
        now: at,
        lastDetectionAt: at - 1_000,
        lastReportAt: at - 10_000,
      }),
    ).toBe('report');
  });
  it('never reports reloads (restored tabs are reloads in Chromium)', () => {
    expect(decideReport({ transitionType: 'reload', now: at })).toBe('ignore');
  });
  it('ignores back/forward within the sliding dedupe window only', () => {
    const q = ['forward_back'];
    expect(
      decideReport({
        transitionType: 'link',
        transitionQualifiers: q,
        now: at,
        lastDetectionAt: at - 29_999,
      }),
    ).toBe('ignore');
    expect(
      decideReport({
        transitionType: 'link',
        transitionQualifiers: q,
        now: at,
        lastDetectionAt: at - 30_000,
      }),
    ).toBe('report');
    expect(decideReport({ transitionType: 'link', transitionQualifiers: q, now: at })).toBe(
      'report',
    );
  });
  it('does not send the same target twice within a moment', () => {
    expect(
      decideReport({
        transitionType: 'typed',
        now: at,
        lastReportAt: at - CLIENT_DUPLICATE_MS + 1,
      }),
    ).toBe('duplicate');
    expect(
      decideReport({ transitionType: 'typed', now: at, lastReportAt: at - CLIENT_DUPLICATE_MS }),
    ).toBe('report');
  });
});

// ---------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------

interface Harness {
  tracker: AttemptTracker;
  store: ReturnType<typeof memoryTabStore>;
  tabs: Map<number, TabLike>;
  updates: Array<{ tabId: number; url: string }>;
  reports: Array<{ host: string; incognito: boolean }>;
  setRules(rules: ExtRulesResponse | null): void;
  respond(response: AttemptResponse | null | Promise<AttemptResponse | null>): void;
  advance(ms: number): void;
  /** onBeforeNavigate then onCommitted of the DNR redirect, as Chrome fires them. */
  redirect(tabId: number, url: string, commit?: Partial<CommitDetails>): Promise<void>;
}

function harness(base = BASE): Harness {
  let now = NOW;
  let rules: ExtRulesResponse | null = blockRules();
  let next: AttemptResponse | null | Promise<AttemptResponse | null> = attemptResponse();
  const tabs = new Map<number, TabLike>();
  const updates: Harness['updates'] = [];
  const reports: Harness['reports'] = [];
  const store = memoryTabStore();
  const tabsApi: TabsApi = {
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (tab === undefined) throw new Error('No tab with id');
      return tab;
    },
    async update(tabId, { url }) {
      updates.push({ tabId, url });
      tabs.set(tabId, { ...tabs.get(tabId), id: tabId, url });
    },
    async query() {
      return [...tabs.values()].filter((t) => /^https?:/.test(t.url ?? ''));
    },
  };
  const tracker = createAttemptTracker({
    getEffectiveRules: async () => rules,
    reportAttempt: async (input) => {
      reports.push(input);
      return next;
    },
    extensionBase: base,
    tabs: tabsApi,
    store,
    now: () => now,
    warn: () => undefined,
  });
  return {
    tracker,
    store,
    tabs,
    updates,
    reports,
    setRules: (r) => {
      rules = r;
    },
    respond: (r) => {
      next = r;
    },
    advance: (ms) => {
      now += ms;
    },
    async redirect(tabId, url, commit = {}) {
      if (!tabs.has(tabId)) tabs.set(tabId, { id: tabId, url: 'about:blank', incognito: false });
      tracker.onBeforeNavigate({
        tabId,
        frameId: 0,
        url,
        frameType: 'outermost_frame',
        documentLifecycle: 'active',
      });
      await tracker.onCommitted({
        tabId,
        frameId: 0,
        url: PAGE,
        frameType: 'outermost_frame',
        documentLifecycle: 'active',
        transitionType: 'typed',
        transitionQualifiers: ['from_address_bar', 'server_redirect'],
        ...commit,
      });
    },
  };
}

describe('createAttemptTracker', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('reports a redirected top-level navigation once, host only, and stores what blocked.html shows', async () => {
    await h.redirect(7, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(h.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
    const info = await h.store.get(7);
    expect(info).toMatchObject({
      tabId: 7,
      host: 'www.youtube.com',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      serviceId: 'youtube',
      cause: 'domain',
      status: 'counted',
      at: NOW,
      pointsDelta: -10,
      episodePointsDelta: -10,
      nextPenalty: 20,
      penaltiesEnabled: true,
      block: { id: BLK_YT, reason: 'Quiero aprobar mates' },
    });
  });

  it('passes the incognito flag of the tab', async () => {
    h.tabs.set(9, { id: 9, url: 'about:blank', incognito: true });
    await h.redirect(9, 'https://instagram.com/');
    expect(h.reports).toEqual([{ host: 'instagram.com', incognito: true }]);
  });

  it('ignores prerenders until the page is activated', async () => {
    h.tracker.onBeforeNavigate({
      tabId: 3,
      frameId: 0,
      url: 'https://youtube.com/',
      documentLifecycle: 'prerender',
    });
    await h.tracker.onCommitted({
      tabId: 3,
      frameId: 0,
      url: PAGE,
      documentLifecycle: 'prerender',
      transitionType: 'typed',
    });
    expect(h.reports).toEqual([]);
    expect(await h.store.get(3)).toBeNull();
    // Activation fires the events again as active.
    await h.redirect(3, 'https://youtube.com/');
    expect(h.reports).toHaveLength(1);
  });

  it('never counts sub-frame embeds', async () => {
    h.tracker.onBeforeNavigate({
      tabId: 3,
      frameId: 5,
      url: 'https://www.youtube.com/embed/x',
      frameType: 'sub_frame',
    });
    await h.tracker.onCommitted({
      tabId: 3,
      frameId: 5,
      url: PAGE,
      frameType: 'sub_frame',
      transitionType: 'auto_subframe',
    });
    expect(h.reports).toEqual([]);
  });

  it('never counts blocked.html opened without a redirect (by a page, by hand, or too late)', async () => {
    await h.tracker.onCommitted({ tabId: 4, frameId: 0, url: PAGE, transitionType: 'link' });
    expect(h.reports).toEqual([]);
    // Typed by hand: its onBeforeNavigate clears an older pending navigation.
    h.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: 'https://www.youtube.com/' });
    h.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: PAGE });
    await h.tracker.onCommitted({ tabId: 4, frameId: 0, url: PAGE, transitionType: 'typed' });
    expect(h.reports).toEqual([]);
    // A redirect that commits long after the navigation started.
    h.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: 'https://www.youtube.com/' });
    h.advance(NAV_MATCH_MS + 1);
    await h.tracker.onCommitted({ tabId: 4, frameId: 0, url: PAGE, transitionType: 'typed' });
    expect(h.reports).toEqual([]);
  });

  it('does not report reloads, and shows what the attempt cost', async () => {
    await h.redirect(7, 'https://www.youtube.com/');
    h.advance(5_000);
    h.respond(attemptResponse({ counted: false, merged: true, pointsDelta: 0 }));
    await h.redirect(7, 'https://www.youtube.com/', {
      transitionType: 'reload',
      transitionQualifiers: [],
    });
    expect(h.reports).toHaveLength(1);
    expect(await h.store.get(7)).toMatchObject({
      status: 'ignored',
      pointsDelta: 0,
      episodePointsDelta: -10,
    });
  });

  it('does not report back/forward within the window, but does after it', async () => {
    await h.redirect(7, 'https://www.youtube.com/');
    h.advance(20_000);
    await h.redirect(7, 'https://m.youtube.com/', {
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });
    expect(h.reports).toHaveLength(1);
    h.advance(29_000); // sliding: 29 s after the ignored one
    await h.redirect(7, 'https://youtube.com/', {
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });
    expect(h.reports).toHaveLength(1);
    h.advance(31_000);
    await h.redirect(7, 'https://youtube.com/', {
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });
    expect(h.reports).toHaveLength(2);
  });

  it('sends one report for the same target in two tabs at once; both tabs show it', async () => {
    let resolve: (r: AttemptResponse) => void = () => undefined;
    h.respond(new Promise<AttemptResponse>((r) => (resolve = r)));
    const first = h.redirect(1, 'https://www.youtube.com/');
    const second = h.redirect(2, 'https://youtu.be/abc');
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    resolve(attemptResponse({ pointsDelta: -20, episodePointsDelta: -20, escalationIndex: 1 }));
    await Promise.all([first, second]);
    expect(h.reports).toHaveLength(1);
    expect(await h.store.get(1)).toMatchObject({ status: 'counted', pointsDelta: -20 });
    expect(await h.store.get(2)).toMatchObject({
      status: 'merged',
      pointsDelta: 0,
      episodePointsDelta: -20,
    });
    // Later, a new navigation is reported again (the guardian merges or counts it).
    h.advance(CLIENT_DUPLICATE_MS);
    h.respond(
      attemptResponse({ counted: false, merged: true, pointsDelta: 0, episodePointsDelta: -20 }),
    );
    await h.redirect(1, 'https://www.youtube.com/');
    expect(h.reports).toHaveLength(2);
    expect(await h.store.get(1)).toMatchObject({ status: 'merged', episodePointsDelta: -20 });
  });

  it('keeps the page informative when the guardian does not answer or no longer blocks it', async () => {
    h.respond(null);
    await h.redirect(7, 'https://www.youtube.com/');
    expect(await h.store.get(7)).toMatchObject({
      status: 'unreported',
      pointsDelta: null,
      block: { id: BLK_YT, reason: 'Quiero aprobar mates' },
    });

    h.advance(60_000);
    h.respond(
      attemptResponse({
        blocked: false,
        counted: false,
        pointsDelta: 0,
        block: null,
        reason: 'allowance_active',
      }),
    );
    await h.redirect(8, 'https://www.instagram.com/');
    expect(await h.store.get(8)).toMatchObject({
      status: 'not_counted',
      guardianReason: 'allowance_active',
    });
  });

  it('does not report what the rules in force no longer block', async () => {
    h.setRules(blockRules({ blockDomains: ['example.org'] }));
    await h.redirect(7, 'https://www.youtube.com/');
    expect(h.reports).toEqual([]);
    expect(await h.store.get(7)).toMatchObject({ status: 'not_counted', pointsDelta: 0 });
  });

  it('whitelist mode: reports the hostname with the exam block; IP literals are shown but not sent', async () => {
    h.setRules(examRules());
    h.respond(
      attemptResponse({
        serviceId: null,
        block: { ...examRules().blocks[1]!, reason: 'Examen de física' },
      }),
    );
    await h.redirect(7, 'https://mail.google.com/mail/u/0/');
    expect(h.reports).toEqual([{ host: 'mail.google.com', incognito: false }]);
    expect(await h.store.get(7)).toMatchObject({ cause: 'whitelist', block: { id: BLK_EXAM } });

    await h.redirect(8, 'http://192.168.1.1/admin');
    expect(h.reports).toHaveLength(1);
    expect(await h.store.get(8)).toMatchObject({
      status: 'unreported',
      host: '192.168.1.1',
      cause: 'whitelist',
    });
  });

  it('moves a tab whose blocked page loaded without a redirect, and counts it', async () => {
    h.tabs.set(5, { id: 5, url: 'https://www.youtube.com./' });
    h.tracker.onBeforeNavigate({ tabId: 5, frameId: 0, url: 'https://www.youtube.com./watch' });
    await h.tracker.onCommitted({
      tabId: 5,
      frameId: 0,
      url: 'https://www.youtube.com./watch',
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar'],
    });
    expect(h.updates).toEqual([
      { tabId: 5, url: `${BASE}blocked.html?cause=domain&service=youtube` },
    ]);
    expect(h.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
    // The blocked page then commits without a pending navigation: nothing more.
    await h.tracker.onCommitted({
      tabId: 5,
      frameId: 0,
      url: h.updates[0]!.url,
      transitionType: 'link',
    });
    expect(h.reports).toHaveLength(1);
    expect(await h.store.get(5)).toMatchObject({ status: 'counted' });
  });

  // Event orders recorded in Firefox 136 (e2e/firefox/): DNR's redirect is a new load of
  // blocked.html with its own onBeforeNavigate; webRequest may report it after the commit.
  const FIREFOX_BASE = 'moz-extension://6a1f3b0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b/';

  function firefoxHarness(): Harness & { page: string } {
    return Object.assign(harness(FIREFOX_BASE), {
      page: `${FIREFOX_BASE}blocked.html?cause=domain&service=youtube`,
    });
  }

  it('Firefox: counts a redirect whose blocked.html load fires its own onBeforeNavigate', async () => {
    const f = firefoxHarness();
    f.tabs.set(4, { id: 4, url: 'about:blank', incognito: false });
    f.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: 'https://www.youtube.com/' });
    f.advance(30);
    f.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: f.page });
    await f.tracker.onCommitted({
      tabId: 4,
      frameId: 0,
      url: f.page,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect'],
    });
    expect(f.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
    expect(await f.store.get(4)).toMatchObject({ status: 'counted', host: 'www.youtube.com' });

    // webRequest's onBeforeRedirect after the commit, then a reload of the page: nothing
    // changes (the page still shows what the attempt cost).
    f.tracker.onBeforeRedirect({
      tabId: 4,
      frameId: 0,
      url: 'https://www.youtube.com/',
      redirectUrl: f.page,
      type: 'main_frame',
    });
    f.advance(500);
    f.tracker.onBeforeNavigate({ tabId: 4, frameId: 0, url: f.page });
    await f.tracker.onCommitted({ tabId: 4, frameId: 0, url: f.page, transitionType: 'reload' });
    expect(f.reports).toHaveLength(1);
    expect(await f.store.get(4)).toMatchObject({ status: 'counted', pointsDelta: -10 });
  });

  it('Firefox: counts the site a server redirect led to when webRequest reports it first', async () => {
    const f = firefoxHarness();
    f.tracker.onBeforeNavigate({ tabId: 5, frameId: 0, url: 'https://t.co/abc' });
    f.tracker.onBeforeRedirect({
      tabId: 5,
      frameId: 0,
      url: 'https://t.co/abc',
      redirectUrl: 'https://www.youtube.com/watch?v=1',
      type: 'main_frame',
    });
    f.tracker.onBeforeRedirect({
      tabId: 5,
      frameId: 0,
      url: 'https://www.youtube.com/watch?v=1',
      redirectUrl: f.page,
      type: 'main_frame',
    });
    f.advance(40);
    f.tracker.onBeforeNavigate({ tabId: 5, frameId: 0, url: f.page });
    await f.tracker.onCommitted({
      tabId: 5,
      frameId: 0,
      url: f.page,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect'],
    });
    expect(f.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
  });

  it('Firefox: blocked.html opened by hand after a navigation started is not an attempt', async () => {
    const f = firefoxHarness();
    // Right after: kept, but only a redirect commit matches it.
    f.tracker.onBeforeNavigate({ tabId: 6, frameId: 0, url: 'https://www.youtube.com/' });
    f.advance(BLOCKED_PAGE_FOLLOW_MS);
    f.tracker.onBeforeNavigate({ tabId: 6, frameId: 0, url: f.page });
    await f.tracker.onCommitted({
      tabId: 6,
      frameId: 0,
      url: f.page,
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar'],
    });
    expect(f.reports).toEqual([]);
    // Later than BLOCKED_PAGE_FOLLOW_MS: the navigation is forgotten.
    f.tracker.onBeforeNavigate({ tabId: 6, frameId: 0, url: 'https://www.youtube.com/' });
    f.advance(BLOCKED_PAGE_FOLLOW_MS + 1);
    f.tracker.onBeforeNavigate({ tabId: 6, frameId: 0, url: f.page });
    await f.tracker.onCommitted({
      tabId: 6,
      frameId: 0,
      url: f.page,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect'],
    });
    expect(f.reports).toEqual([]);
    expect(await f.store.get(6)).toBeNull();
  });

  it('Firefox: a reopened tab of a blocked site is moved without points, and its load is not counted', async () => {
    const f = firefoxHarness();
    const url = 'http://www.youtube.com/watch?v=abc';
    const moved = `${FIREFOX_BASE}blocked.html?cause=domain&service=youtube&tab=1`;
    f.tabs.set(8, { id: 8, url, incognito: false });
    // SessionStore commits the restored URL first, with no onBeforeNavigate…
    await f.tracker.onCommitted({ tabId: 8, frameId: 0, url, transitionType: 'link' });
    expect(f.updates).toEqual([{ tabId: 8, url: moved }]);
    expect(await f.store.get(8)).toMatchObject({
      status: 'enforced',
      pointsDelta: 0,
      host: 'www.youtube.com',
      block: { id: BLK_YT },
    });
    // …then loads it (aborted by the move), and the moved tab commits blocked.html.
    f.advance(17);
    f.tracker.onBeforeNavigate({ tabId: 8, frameId: 0, url });
    f.advance(27);
    f.tracker.onBeforeNavigate({ tabId: 8, frameId: 0, url: moved });
    await f.tracker.onCommitted({ tabId: 8, frameId: 0, url: moved, transitionType: 'link' });
    expect(f.reports).toEqual([]);
    expect(await f.store.get(8)).toMatchObject({ status: 'enforced' });

    // Had DNR redirected that history load instead, it is not reported either.
    f.tabs.set(9, { id: 9, url, incognito: false });
    f.advance(1_000);
    await f.tracker.onCommitted({ tabId: 9, frameId: 0, url, transitionType: 'link' });
    f.tracker.onBeforeNavigate({ tabId: 9, frameId: 0, url });
    f.tracker.onBeforeNavigate({ tabId: 9, frameId: 0, url: f.page });
    await f.tracker.onCommitted({
      tabId: 9,
      frameId: 0,
      url: f.page,
      transitionType: 'link',
      transitionQualifiers: ['forward_back', 'server_redirect'],
    });
    expect(f.reports).toEqual([]);
    expect(await f.store.get(9)).toMatchObject({ status: 'ignored', pointsDelta: 0 });
  });

  it('forgets a tab that moved on to an allowed page or closed', async () => {
    await h.redirect(7, 'https://www.youtube.com/');
    await h.tracker.onCommitted({
      tabId: 7,
      frameId: 0,
      url: 'https://es.wikipedia.org/',
      transitionType: 'typed',
    });
    expect(await h.store.get(7)).toBeNull();
    await h.redirect(8, 'https://www.youtube.com/');
    await h.tracker.onTabRemoved(8);
    expect(await h.store.get(8)).toBeNull();
  });

  it('moves tabs already open on a newly blocked site, without counting an attempt', async () => {
    h.tabs.set(1, { id: 1, url: 'https://www.youtube.com/watch?v=1' });
    h.tabs.set(2, { id: 2, url: 'https://es.wikipedia.org/' });
    h.tabs.set(3, { id: 3, url: 'chrome://newtab/' });
    h.tabs.set(4, { id: 4, url: 'https://accounts.youtube.com/' });
    h.tabs.set(5, { id: 5, url: 'https://sub.example.org/x' });
    // Tab 1 started loading YouTube just before the block: that is not an attempt either.
    h.tracker.onBeforeNavigate({ tabId: 1, frameId: 0, url: 'https://www.youtube.com/watch?v=1' });

    expect(await h.tracker.enforceOpenTabs(blockRules())).toEqual([1, 5]);
    expect(h.updates).toEqual([
      { tabId: 1, url: `${BASE}blocked.html?cause=domain&service=youtube&tab=1` },
      { tabId: 5, url: `${BASE}blocked.html?cause=domain&tab=1` },
    ]);
    expect(await h.store.get(1)).toMatchObject({
      status: 'enforced',
      pointsDelta: 0,
      url: 'https://www.youtube.com/watch?v=1',
      block: { id: BLK_YT },
    });

    await h.tracker.onCommitted({
      tabId: 1,
      frameId: 0,
      url: h.updates[0]!.url,
      transitionType: 'link',
    });
    expect(h.reports).toEqual([]);
    expect(await h.store.get(1)).toMatchObject({ status: 'enforced' });
    expect(await h.tracker.enforceOpenTabs(null)).toEqual([]);
  });

  it('in whitelist mode moves every open tab that is not allowed', async () => {
    h.tabs.set(1, { id: 1, url: 'https://mail.google.com/' });
    h.tabs.set(2, { id: 2, url: 'https://docs.google.com/document/d/1' });
    h.tabs.set(3, { id: 3, url: 'http://localhost:5173/' });
    expect(await h.tracker.enforceOpenTabs(examRules())).toEqual([1]);
    expect(h.updates).toEqual([{ tabId: 1, url: `${BASE}blocked.html?cause=whitelist&tab=1` }]);
    expect(await h.store.get(1)).toMatchObject({
      cause: 'whitelist',
      serviceId: null,
      block: { id: BLK_EXAM },
    });
  });

  it('answers blocked.html in the main frame of its own tab only', async () => {
    await h.redirect(7, 'https://www.youtube.com/');
    const sender = { id: 'x', tab: { id: 7 } as chrome.tabs.Tab, frameId: 0, url: PAGE };
    expect(await h.tracker.handleMessage(sender)).toMatchObject({ tabId: 7, status: 'counted' });
    expect(await h.tracker.handleMessage({ ...sender, frameId: 2 })).toBeNull();
    expect(await h.tracker.handleMessage({ ...sender, url: `${BASE}popup.html` })).toBeNull();
    expect(await h.tracker.handleMessage({ ...sender, tab: undefined })).toBeNull();
  });

  describe('through an HTTP redirect (t.co, bit.ly, google.com/url, l.facebook.com…)', () => {
    const active = { frameId: 0, frameType: 'outermost_frame', documentLifecycle: 'active' };
    const serverCommit: CommitDetails = {
      tabId: 7,
      ...active,
      url: PAGE,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect'],
    };

    /** A link click: onBeforeNavigate fires once, for the redirector. */
    function click(tabId: number, url: string): void {
      h.tabs.set(tabId, { id: tabId, url: 'https://x.com/home', incognito: false });
      h.tracker.onBeforeNavigate({ tabId, ...active, url });
    }

    /** webRequest.onBeforeRedirect of a tab's main-frame request. */
    function hop(tabId: number, url: string, redirectUrl: string, extra = {}): void {
      h.tracker.onBeforeRedirect({
        tabId,
        ...active,
        type: 'main_frame',
        url,
        redirectUrl,
        ...extra,
      });
    }

    it('counts the target of the last server redirect, not the redirector (Chromium)', async () => {
      // Chromium reports the 302 but not DNR's own redirect to blocked.html.
      const target = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      click(7, 'https://t.co/AbCdEf123');
      hop(7, 'https://t.co/AbCdEf123', target, { statusCode: 301 });
      await h.tracker.onCommitted(serverCommit);
      expect(h.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
      expect(await h.store.get(7)).toMatchObject({
        host: 'www.youtube.com',
        url: target,
        serviceId: 'youtube',
        status: 'counted',
        pointsDelta: -10,
        block: { id: BLK_YT },
      });
    });

    it('counts the site DNR redirected when the browser reports that redirect', async () => {
      click(7, 'https://t.co/AbCdEf123');
      hop(7, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', PAGE);
      await h.tracker.onCommitted(serverCommit);
      expect(h.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);
      expect(await h.store.get(7)).toMatchObject({ host: 'www.youtube.com', status: 'counted' });
    });

    it('follows a chain of server redirects to a custom host, with its block and countdown', async () => {
      const custom = {
        id: BLK_CUSTOM,
        kind: 'manual',
        mode: 'normal',
        endsAt: iso(NOW + 30 * MIN),
        reason: '',
      } as const;
      h.respond(attemptResponse({ serviceId: null, block: custom }));
      click(7, 'https://bit.ly/3xYz');
      hop(7, 'https://bit.ly/3xYz', 'https://lnkd.in/gAbC');
      hop(7, 'https://lnkd.in/gAbC', 'https://www.example.org/post/1');
      await h.tracker.onCommitted({ ...serverCommit, url: `${BASE}blocked.html?cause=domain` });
      expect(h.reports).toEqual([{ host: 'www.example.org', incognito: false }]);
      expect(await h.store.get(7)).toMatchObject({
        host: 'www.example.org',
        serviceId: null,
        cause: 'domain',
        status: 'counted',
        block: { id: BLK_CUSTOM, endsAt: iso(NOW + 30 * MIN) },
      });
    });

    it('a Google result link (google.com/url) counts for the site it leads to', async () => {
      const link = 'https://www.google.com/url?q=https://www.instagram.com/p/x';
      click(7, link);
      hop(7, link, 'https://www.instagram.com/p/x');
      hop(7, 'https://www.instagram.com/p/x', PAGE);
      await h.tracker.onCommitted(serverCommit);
      expect(h.reports).toEqual([{ host: 'www.instagram.com', incognito: false }]);
    });

    it('a server redirect straight to blocked.html stays the redirector, which is never an attempt', async () => {
      click(7, 'https://evil.example.net/');
      hop(7, 'https://evil.example.net/', PAGE, { statusCode: 302 });
      await h.tracker.onCommitted(serverCommit);
      expect(h.reports).toEqual([]);
      expect(await h.store.get(7)).toMatchObject({
        host: 'evil.example.net',
        status: 'not_counted',
      });
    });

    it('ignores redirects of sub-frames, prerenders, other tabs and other schemes', async () => {
      click(7, 'https://t.co/AbCdEf123');
      hop(7, 'https://t.co/AbCdEf123', 'https://www.youtube.com/');
      hop(7, 'https://www.instagram.com/embed', PAGE, {
        frameId: 5,
        frameType: 'sub_frame',
        type: 'sub_frame',
      });
      hop(7, 'https://www.instagram.com/', PAGE, { documentLifecycle: 'prerender' });
      hop(-1, 'https://www.instagram.com/', PAGE);
      hop(8, 'https://www.instagram.com/', PAGE);
      await h.tracker.onCommitted(serverCommit);
      expect(h.reports).toEqual([{ host: 'www.youtube.com', incognito: false }]);

      // A redirect out of the web (an app link) ends what the navigation stood for.
      h.advance(CLIENT_DUPLICATE_MS);
      click(9, 'https://www.youtube.com/');
      hop(9, 'https://www.youtube.com/', 'vnd.youtube://watch');
      await h.tracker.onCommitted({ ...serverCommit, tabId: 9 });
      expect(h.reports).toHaveLength(1);
    });

    it('a new navigation in the tab replaces an older redirect', async () => {
      click(7, 'https://t.co/AbCdEf123');
      hop(7, 'https://t.co/AbCdEf123', 'https://www.youtube.com/');
      click(7, 'https://www.instagram.com/');
      await h.tracker.onCommitted({ ...serverCommit, transitionType: 'typed' });
      expect(h.reports).toEqual([{ host: 'www.instagram.com', incognito: false }]);
    });
  });

  it('keeps block data from the rules when the guardian names no block', async () => {
    h.respond(attemptResponse({ block: null }));
    h.advance(10 * MIN);
    await h.redirect(7, 'https://www.example.org/');
    expect(await h.store.get(7)).toMatchObject({ serviceId: null, block: { reason: '' } });
  });
});

describe('installAttemptListeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fakeEvent() {
    return { addListener: vi.fn(), removeListener: vi.fn() };
  }

  function fakeTracker(): AttemptTracker {
    return {
      onBeforeNavigate: vi.fn(),
      onBeforeRedirect: vi.fn(),
      onCommitted: vi.fn(async () => undefined),
      onTabRemoved: vi.fn(async () => undefined),
      enforceOpenTabs: vi.fn(async () => []),
      handleMessage: vi.fn(async () => null),
    };
  }

  function stubChrome(withWebRequest: boolean) {
    const api = {
      webNavigation: { onBeforeNavigate: fakeEvent(), onCommitted: fakeEvent() },
      webRequest: withWebRequest ? { onBeforeRedirect: fakeEvent() } : undefined,
      tabs: { onRemoved: fakeEvent() },
    };
    vi.stubGlobal('chrome', api);
    return api;
  }

  it('reads non-blocking main-frame redirects of web pages and removes the listener', () => {
    const api = stubChrome(true);
    const tracker = fakeTracker();
    const stop = installAttemptListeners(tracker, BASE);
    const add = api.webRequest!.onBeforeRedirect.addListener;
    expect(add).toHaveBeenCalledTimes(1);
    // No `blocking` extraInfoSpec: MV3 allows the non-blocking listener only.
    expect(add.mock.calls[0]!.slice(1)).toEqual([
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
    ]);
    const details = {
      tabId: 7,
      frameId: 0,
      url: 'https://www.youtube.com/',
      redirectUrl: PAGE,
      type: 'main_frame',
    };
    (add.mock.calls[0]![0] as (d: typeof details) => void)(details);
    expect(tracker.onBeforeRedirect).toHaveBeenCalledWith(details);
    stop();
    expect(api.webRequest!.onBeforeRedirect.removeListener).toHaveBeenCalledWith(
      add.mock.calls[0]![0],
    );
  });

  it('still counts attempts (for the first URL) when webRequest is unavailable', () => {
    const api = stubChrome(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = installAttemptListeners(fakeTracker(), BASE);
    expect(api.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('webRequest is unavailable'));
    expect(stop).not.toThrow();
  });

  it('the manifest asks for webNavigation and non-blocking webRequest (never webRequestBlocking)', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../public/manifest.json'), 'utf8'),
    ) as { permissions: string[]; host_permissions: string[] };
    expect(manifest.permissions).toEqual(expect.arrayContaining(['webNavigation', 'webRequest']));
    expect(manifest.permissions).not.toContain('webRequestBlocking');
    expect(manifest.host_permissions).toContain('<all_urls>');
  });
});

describe('plugin', () => {
  it('recognizes only its own message', () => {
    expect(isBlockedInfoRequest({ type: BLOCKED_INFO_MESSAGE })).toBe(true);
    expect(isBlockedInfoRequest({ type: BLOCKED_INFO_MESSAGE, tabId: 3 })).toBe(false);
    expect(isBlockedInfoRequest({ type: 'centrate/get-state' })).toBe(false);
    expect(isBlockedInfoRequest(null)).toBe(false);
  });

  it('registers on import and passes on messages that are not its own', () => {
    const plugin = backgroundPlugins().find((p) => p.name === 'attempts');
    expect(plugin?.start).toBeTypeOf('function');
    expect(plugin?.handleMessage?.({ type: 'centrate/get-state' }, {})).toBeUndefined();
  });
});
