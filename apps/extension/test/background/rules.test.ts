import { describe, expect, it } from 'vitest';
import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import {
  BLOCKED_TAB_KEY_PREFIX,
  DNR_PRIORITY,
  LOOPBACK_REGEX_FILTER,
  blockedPagePath,
  blockedTabKey,
  buildDnrRules,
  groupDomainsByService,
  hostFromUrl,
  hostPatternToRegexFilter,
  isBlockedPageUrl,
  parseBlockedPageParams,
  parseBlockedTabInfo,
} from '../../src/background/rules';
import { matchHost, pruneRules } from '../../src/background/state';
import {
  BLK_YT,
  MIN,
  NOW,
  TIKTOK,
  YOUTUBE,
  blockRules,
  evaluateDnr,
  examRules,
  iso,
} from './enforcement-fixtures';

const rulesOf = (rules: ExtRulesResponse | null) => buildDnrRules(rules).rules;

describe('blocked.html URL contract', () => {
  it('round-trips the cause, the service and the open-tab flag', () => {
    const path = blockedPagePath({ cause: 'domain', serviceId: 'youtube', enforced: false });
    expect(path).toBe('/blocked.html?cause=domain&service=youtube');
    expect(parseBlockedPageParams(path)).toEqual({
      cause: 'domain',
      serviceId: 'youtube',
      enforced: false,
    });
    const tab = blockedPagePath({ cause: 'whitelist', serviceId: null, enforced: true });
    expect(tab).toBe('/blocked.html?cause=whitelist&tab=1');
    expect(parseBlockedPageParams(`chrome-extension://abc/${tab.slice(1)}#x`)).toEqual({
      cause: 'whitelist',
      serviceId: null,
      enforced: true,
    });
  });

  it('never carries anything but display hints, and sanitizes what anyone could type', () => {
    expect(parseBlockedPageParams('?cause=<script>&service=../../x&tab=yes&reason=hola')).toEqual({
      cause: 'domain',
      serviceId: null,
      enforced: false,
    });
    expect(parseBlockedPageParams('')).toEqual({
      cause: 'domain',
      serviceId: null,
      enforced: false,
    });
    expect(blockedPagePath({ cause: 'domain', serviceId: 'Not An Id', enforced: false })).toBe(
      '/blocked.html?cause=domain',
    );
  });

  it('recognizes the extension page only', () => {
    const base = 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah/';
    expect(isBlockedPageUrl(`${base}blocked.html`, base)).toBe(true);
    expect(isBlockedPageUrl(`${base}blocked.html?cause=domain`, base)).toBe(true);
    expect(isBlockedPageUrl(`${base}blocked.html.evil`, base)).toBe(false);
    expect(isBlockedPageUrl(`${base}popup.html`, base)).toBe(false);
    expect(isBlockedPageUrl('https://example.org/blocked.html', base)).toBe(false);
  });
});

describe('hostFromUrl', () => {
  it('returns the DNR host of http(s) URLs only', () => {
    expect(hostFromUrl('https://WWW.YouTube.com./watch?v=1')).toBe('www.youtube.com');
    expect(hostFromUrl('http://[::1]:8080/')).toBe('[::1]');
    expect(hostFromUrl('https://ñandú.es/')).toBe('xn--and-6ma2c.es');
    expect(hostFromUrl('chrome://newtab/')).toBeNull();
    expect(hostFromUrl('moz-extension://uuid/blocked.html')).toBeNull();
    expect(hostFromUrl('not a url')).toBeNull();
  });
});

describe('BlockedTabInfo', () => {
  it('has a storage key per tab and rejects malformed records', () => {
    expect(blockedTabKey(12)).toBe(`${BLOCKED_TAB_KEY_PREFIX}12`);
    const info = {
      v: 1,
      tabId: 12,
      host: 'www.youtube.com',
      url: 'https://www.youtube.com/',
      serviceId: 'youtube',
      cause: 'domain',
      status: 'counted',
      at: NOW,
      pointsDelta: -10,
      episodePointsDelta: -10,
      nextPenalty: 20,
      penaltiesEnabled: true,
      guardianReason: null,
      block: { id: BLK_YT, kind: 'manual', mode: 'strict', endsAt: iso(NOW), reason: 'Mates' },
    };
    expect(parseBlockedTabInfo(info)).toEqual(info);
    expect(parseBlockedTabInfo({ ...info, status: 'hacked' })).toBeNull();
    expect(parseBlockedTabInfo({ ...info, pointsDelta: '−10' })).toBeNull();
    expect(parseBlockedTabInfo({ ...info, block: { reason: 1 } })).toBeNull();
    expect(parseBlockedTabInfo(null)).toBeNull();
  });
});

describe('hostPatternToRegexFilter', () => {
  const docs = '^[a-z0-9-]+-docs\\.googleusercontent\\.com$';
  const lh = '^lh[3-7](?:-[a-z]+)?\\.googleusercontent\\.com$';
  const thumbs = '^lh[3-7]\\.google\\.com$';

  it('turns the catalog host patterns into whole-URL filters', () => {
    expect(hostPatternToRegexFilter(thumbs)).toBe(
      '^https?://(?:lh[3-7]\\.google\\.com)(?::[0-9]+)?(?:[/?#]|$)',
    );
    for (const pattern of [docs, lh, thumbs])
      expect(hostPatternToRegexFilter(pattern)).not.toBeNull();
  });

  it('matches the host and nothing that only looks like it', () => {
    const filter = new RegExp(hostPatternToRegexFilter(thumbs) ?? '(?!)');
    expect(filter.test('https://lh3.google.com/u/0/d/abc')).toBe(true);
    expect(filter.test('https://lh7.google.com:443')).toBe(true);
    expect(filter.test('https://lh3.google.com?x')).toBe(true);
    expect(filter.test('https://lh3.google.com.evil.com/')).toBe(false);
    expect(filter.test('https://evil.com/lh3.google.com')).toBe(false);
    expect(filter.test('https://lh3.google.com@evil.com/')).toBe(false);
    expect(filter.test('https://x.lh3.google.com/')).toBe(false);
    const drive = new RegExp(hostPatternToRegexFilter(docs) ?? '(?!)');
    expect(drive.test('https://doc-0s-8c-docs.googleusercontent.com/docs/x')).toBe(true);
    expect(drive.test('https://evil.com/?a=doc-0s-docs.googleusercontent.com')).toBe(false);
  });

  it('refuses patterns that could match across the host boundary or are not RE2', () => {
    for (const pattern of [
      'lh3\\.google\\.com', // not anchored
      '^lh3\\.google\\.com\\$', // escaped end anchor
      '^.*\\.google\\.com$', // wildcard can span "/"
      '^[^.]+\\.google\\.com$', // negated class
      '^[!-~]+\\.google\\.com$', // range over "/" and ":"
      '^[a-z/]+\\.com$', // delimiter in a class
      '^evil\\.com\\/x\\.google\\.com$', // escaped delimiter
      '^a\\x2fb\\.com$', // hex escape
      '^(?=a)a\\.com$', // lookahead
      '^(a)\\1\\.com$', // backreference
      '^a\\.com$|^b\\.com$', // inner anchors
      '^\\S+\\.com$', // negated shorthand
      '^[[:alpha:]]+\\.com$', // POSIX class
      '^[]a]\\.com$', // RE2/JS disagree
    ]) {
      expect(hostPatternToRegexFilter(pattern), pattern).toBeNull();
    }
  });
});

describe('buildDnrRules', () => {
  it('has nothing to do without rules or without anything to enforce', () => {
    expect(rulesOf(null)).toEqual([]);
    expect(rulesOf(blockRules({ blockDomains: [], blocks: [] }))).toEqual([]);
  });

  it('maps a block payload (snapshot)', () => {
    const plan = buildDnrRules(blockRules());
    expect(plan.droppedPatterns).toEqual([]);
    expect(plan.merged).toBe(false);
    expect(plan.rules).toMatchSnapshot();
  });

  it('maps an exam (whitelist) payload (snapshot)', () => {
    const plan = buildDnrRules(examRules());
    expect(plan.droppedPatterns).toEqual([]);
    expect(plan.rules).toMatchSnapshot();
  });

  it('orders priorities as §8.8: exempt allow > blocked redirect > whitelist allow > whitelist redirect', () => {
    expect(DNR_PRIORITY.allowExempt).toBeGreaterThan(DNR_PRIORITY.redirectBlocked);
    expect(DNR_PRIORITY.redirectBlocked).toBeGreaterThan(DNR_PRIORITY.allowWhitelist);
    expect(DNR_PRIORITY.allowWhitelist).toBeGreaterThan(DNR_PRIORITY.redirectWhitelist);
    const rules = rulesOf(examRules());
    const priorities = rules.map((r) => r.priority ?? 1);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    const byKind = (type: string, priority: number) =>
      rules.filter((r) => r.action.type === type && r.priority === priority).length;
    expect(byKind('allow', DNR_PRIORITY.allowExempt)).toBe(2); // excluded + loopback
    expect(byKind('redirect', DNR_PRIORITY.redirectBlocked)).toBe(1); // youtube
    expect(byKind('allow', DNR_PRIORITY.allowWhitelist)).toBe(4); // domains + 3 patterns
    expect(byKind('redirect', DNR_PRIORITY.redirectWhitelist)).toBe(1);
  });

  it('groups blocked hosts by catalog service; unknown hosts share service-less rules', () => {
    expect(
      groupDomainsByService(['www.example.org', 'youtu.be', 'instagram.com', 'youtube.com']),
    ).toEqual([
      ['instagram', ['instagram.com']],
      ['youtube', ['youtu.be', 'youtube.com']],
      [null, ['www.example.org']],
    ]);
    const redirects = rulesOf(blockRules()).filter(
      (r) => r.priority === DNR_PRIORITY.redirectBlocked,
    );
    expect(redirects.map((r) => r.action.redirect?.extensionPath)).toEqual([
      '/blocked.html?cause=domain&service=instagram',
      '/blocked.html?cause=domain&service=youtube',
      '/blocked.html?cause=domain',
    ]);
    for (const rule of redirects)
      expect(rule.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);
  });

  it('blocks listed hosts and their subdomains, frames included, and keeps excluded hosts open', () => {
    const rules = rulesOf(blockRules());
    expect(evaluateDnr(rules, 'https://www.youtube.com/watch?v=1')).toEqual({
      action: 'redirect',
      to: '/blocked.html?cause=domain&service=youtube',
    });
    expect(evaluateDnr(rules, 'https://es.m.youtube.com/', 'main_frame').action).toBe('redirect');
    expect(evaluateDnr(rules, 'https://www.youtube.com/embed/x', 'sub_frame').action).toBe(
      'redirect',
    );
    expect(evaluateDnr(rules, 'https://i.ytimg.com/x.jpg', 'image').action).toBe('none');
    expect(evaluateDnr(rules, 'https://accounts.youtube.com/accounts/SetSID').action).toBe('allow');
    expect(evaluateDnr(rules, 'https://sub.example.org/').to).toBe('/blocked.html?cause=domain');
    expect(evaluateDnr(rules, 'https://wikipedia.org/').action).toBe('none');
    expect(evaluateDnr(rules, 'http://127.0.0.1:47600/v1/health').action).toBe('allow');
  });

  it('whitelist mode: only allowed hosts open, listed hosts stay blocked, sub-resources untouched', () => {
    const rules = rulesOf(examRules());
    const wl = '/blocked.html?cause=whitelist';
    expect(evaluateDnr(rules, 'https://es.wikipedia.org/wiki/Física')).toEqual({ action: 'allow' });
    expect(evaluateDnr(rules, 'https://docs.google.com/document/d/1')).toEqual({ action: 'allow' });
    expect(evaluateDnr(rules, 'https://lh3.google.com/u/0/d/1')).toEqual({ action: 'allow' });
    expect(evaluateDnr(rules, 'https://doc-0s-8c-docs.googleusercontent.com/x')).toEqual({
      action: 'allow',
    });
    expect(evaluateDnr(rules, 'https://evil.com/lh3.google.com')).toEqual({
      action: 'redirect',
      to: wl,
    });
    expect(evaluateDnr(rules, 'https://mail.google.com/')).toEqual({ action: 'redirect', to: wl });
    expect(evaluateDnr(rules, 'http://192.168.1.1/')).toEqual({ action: 'redirect', to: wl });
    // youtube.com is on this whitelist, but another block lists it: it stays blocked.
    expect(evaluateDnr(rules, 'https://www.youtube.com/').to).toBe(
      '/blocked.html?cause=domain&service=youtube',
    );
    // Always-allowed and loopback hosts stay open.
    expect(evaluateDnr(rules, 'https://accounts.youtube.com/').action).toBe('allow');
    expect(evaluateDnr(rules, 'http://localhost:5173/').action).toBe('allow');
    expect(evaluateDnr(rules, 'http://[::1]:3000/').action).toBe('allow');
    // The whitelist rule never touches embeds or sub-resources.
    expect(evaluateDnr(rules, 'https://cdn.example.net/app.js', 'script').action).toBe('none');
    expect(evaluateDnr(rules, 'https://player.vimeo.com/video/1', 'sub_frame').action).toBe('none');
  });

  it('agrees with matchHost (the attempt check) on top-level navigations', () => {
    for (const rules of [blockRules(), examRules()]) {
      const dnr = rulesOf(rules);
      for (const host of [
        'youtube.com',
        'www.youtube.com',
        'music.youtube.com',
        'accounts.youtube.com',
        'instagram.com',
        'www.example.org',
        'example.org',
        'wikipedia.org',
        'es.wikipedia.org',
        'docs.google.com',
        'lh5.google.com',
        'mail.google.com',
        'localhost',
        '127.0.0.1',
      ]) {
        const blocked = evaluateDnr(dnr, `https://${host}/`).action === 'redirect';
        expect(blocked, host).toBe(matchHost(rules, host).blocked);
      }
    }
  });

  it('allowances: hosts the guardian opened are not redirected until the allowance ends', () => {
    const endsAt = NOW + 15 * MIN;
    const withAllowance = blockRules({
      blockDomains: [...YOUTUBE],
      excludedDomains: [],
      blocks: [
        {
          ...blockRules().blocks[0]!,
          serviceIds: ['youtube', 'tiktok'],
          domains: [...YOUTUBE, ...TIKTOK],
        },
      ],
      allowances: [{ serviceId: 'tiktok', endsAt: iso(endsAt) }],
      nextChangeAt: iso(endsAt),
    });
    expect(evaluateDnr(rulesOf(withAllowance), 'https://www.tiktok.com/').action).toBe('none');
    expect(evaluateDnr(rulesOf(withAllowance), 'https://www.youtube.com/').action).toBe('redirect');
    // Guardian unreachable: state.ts prunes at the cached end and the hosts close again.
    const later = pruneRules(withAllowance, endsAt + 1);
    expect(evaluateDnr(rulesOf(later), 'https://www.tiktok.com/')).toEqual({
      action: 'redirect',
      to: '/blocked.html?cause=domain&service=tiktok',
    });
    // And nothing reopens before the block's own end.
    expect(rulesOf(pruneRules(withAllowance, endsAt - 1))).toEqual(rulesOf(withAllowance));
  });

  it('chunks long host lists', () => {
    const many = Array.from({ length: 25 }, (_, i) => `site${i}.example.net`);
    const plan = buildDnrRules(blockRules({ blockDomains: many, excludedDomains: [] }), {
      limits: { domainsPerRule: 10 },
    });
    const redirects = plan.rules.filter((r) => r.action.type === 'redirect');
    expect(redirects.map((r) => r.condition.requestDomains?.length)).toEqual([10, 10, 5]);
    expect(redirects.flatMap((r) => r.condition.requestDomains)).toEqual([...many].sort());
  });

  it('merges services instead of dropping hosts when the rule budget is tight', () => {
    const plan = buildDnrRules(blockRules(), { limits: { maxRules: 3 } });
    expect(plan.merged).toBe(true);
    expect(plan.rules.length).toBeLessThanOrEqual(3);
    const blocked = plan.rules
      .filter((r) => r.action.type === 'redirect')
      .flatMap((r) => r.condition.requestDomains ?? []);
    expect(blocked.sort()).toEqual([...blockRules().blockDomains].sort());
    expect(evaluateDnr(plan.rules, 'https://www.youtube.com/')).toEqual({
      action: 'redirect',
      to: '/blocked.html?cause=domain',
    });
  });

  it('leaves out unsafe, unsupported and over-budget host patterns (stricter, never looser)', () => {
    const rules = examRules({
      whitelist: {
        allowDomains: ['wikipedia.org'],
        allowHostPatterns: [
          '^.*\\.google\\.com$',
          '^lh[3-7]\\.google\\.com$',
          '^[a-z0-9-]+-docs\\.googleusercontent\\.com$',
        ],
      },
    });
    const unsupported = new Set([hostPatternToRegexFilter('^lh[3-7]\\.google\\.com$') ?? '']);
    const plan = buildDnrRules(rules, { unsupportedRegex: unsupported });
    expect(plan.droppedPatterns).toEqual(['^.*\\.google\\.com$', '^lh[3-7]\\.google\\.com$']);
    expect(evaluateDnr(plan.rules, 'https://lh3.google.com/').action).toBe('redirect');

    const tight = buildDnrRules(rules, { limits: { maxRegexRules: 2 } });
    const regexRules = tight.rules.filter((r) => r.condition.regexFilter !== undefined);
    expect(regexRules.length).toBe(2);
    expect(regexRules[0]?.condition.regexFilter).toBe(LOOPBACK_REGEX_FILTER);

    const none = buildDnrRules(rules, { skipHostPatterns: true });
    expect(none.rules.filter((r) => r.condition.regexFilter !== undefined)).toHaveLength(1);
  });

  it('never passes an invalid domain to the browser (one would make the whole update fail)', () => {
    const rules = blockRules({
      blockDomains: ['youtube.com', 'Bad Host', '127.0.0.1'],
      excludedDomains: ['x'],
    });
    const domains = rulesOf(rules).flatMap((r) => r.condition.requestDomains ?? []);
    expect(domains).toEqual(['youtube.com']);
  });
});
