import { describe, expect, it } from 'vitest';
import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import { buildDnrRules } from '../../src/background/rules';
import {
  buildSnapshot,
  closeEndedAllowances,
  computeEffectiveRules,
  linkTrustsRules,
  matchHost,
  mergeCarriedRules,
  nextRulesChangeAt,
  parseBackgroundRequest,
  pruneRules,
} from '../../src/background/state';
import type { RulesRecord } from '../../src/background/storage';
import { EMPTY_STATUS } from '../../src/background/storage';
import {
  BLK_A,
  BLK_B,
  BLK_W,
  EXT_1,
  MIN,
  NOW,
  TIKTOK_HOSTS,
  YOUTUBE_HOSTS,
  iso,
  pairingFixture,
  rulesFixture,
} from './fakes';
import { evaluateDnr } from './enforcement-fixtures';

const KEY = 'A'.repeat(122);

function twoBlocks(): ExtRulesResponse {
  return rulesFixture({
    blockDomains: [...YOUTUBE_HOSTS, ...TIKTOK_HOSTS],
    blocks: [
      {
        id: BLK_A,
        kind: 'manual',
        mode: 'strict',
        endsAt: iso(NOW + 30 * MIN),
        reason: 'Quiero aprobar mates',
        serviceIds: ['youtube'],
        domains: [...YOUTUBE_HOSTS],
        whitelistOnly: false,
      },
      {
        id: BLK_B,
        kind: 'schedule',
        mode: 'normal',
        endsAt: iso(NOW + 90 * MIN),
        reason: 'Tardes sin TikTok',
        serviceIds: ['tiktok'],
        domains: [...TIKTOK_HOSTS],
        whitelistOnly: false,
      },
    ],
    nextChangeAt: iso(NOW + 30 * MIN),
  });
}

function record(rules: ExtRulesResponse, carried: ExtRulesResponse | null = null): RulesRecord {
  return {
    v: 1,
    rules,
    extensionId: EXT_1,
    etag: `"r-${rules.extRulesVersion}"`,
    rulesPublicKey: KEY,
    receivedAt: NOW,
    carried: carried === null ? null : { rules: carried, rulesPublicKey: 'B'.repeat(122) },
  };
}

describe('pruneRules', () => {
  it('returns the same object while nothing has ended', () => {
    const rules = twoBlocks();
    expect(pruneRules(rules, NOW)).toBe(rules);
    expect(pruneRules(rules, NOW + 29 * MIN)).toBe(rules);
  });

  it('drops an ended block and only its hosts, and moves nextChangeAt', () => {
    const pruned = pruneRules(twoBlocks(), NOW + 31 * MIN);
    expect(pruned.blocks.map((b) => b.id)).toEqual([BLK_B]);
    expect(pruned.blockDomains).toEqual(TIKTOK_HOSTS);
    expect(pruned.nextChangeAt).toBe(iso(NOW + 90 * MIN));
    expect(pruned.excludedDomains).toEqual(['accounts.youtube.com']);
  });

  it('keeps a host another live block still lists', () => {
    const rules = twoBlocks();
    rules.blocks[1]?.domains.push('youtube.com');
    const pruned = pruneRules(rules, NOW + 31 * MIN);
    expect(pruned.blockDomains).toEqual(['youtube.com', ...TIKTOK_HOSTS]);
  });

  it('blocks again the hosts of an allowance that ended while offline', () => {
    const rules = rulesFixture({
      // The guardian subtracted YouTube while a 15-minute allowance was running.
      blockDomains: [],
      allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 15 * MIN) }],
      nextChangeAt: iso(NOW + 15 * MIN),
    });
    expect(pruneRules(rules, NOW + 10 * MIN)).toBe(rules);
    const pruned = pruneRules(rules, NOW + 16 * MIN);
    expect(pruned.allowances).toEqual([]);
    expect(new Set(pruned.blockDomains)).toEqual(new Set(YOUTUBE_HOSTS));
    expect(pruned.nextChangeAt).toBe(iso(NOW + 30 * MIN));
  });

  it('never reopens always-allowed hosts when an allowance ends', () => {
    const rules = rulesFixture({
      blockDomains: [],
      blocks: [
        {
          ...rulesFixture().blocks[0]!,
          domains: [...YOUTUBE_HOSTS, 'accounts.youtube.com'],
        },
      ],
      allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 5 * MIN) }],
    });
    const pruned = pruneRules(rules, NOW + 6 * MIN);
    expect(pruned.blockDomains).not.toContain('accounts.youtube.com');
    expect(pruned.blockDomains).toContain('youtube.com');
  });

  it('removes the whitelist with the last whitelist block and ended punishments', () => {
    const rules = rulesFixture({
      blocks: [
        ...rulesFixture().blocks,
        {
          id: BLK_W,
          kind: 'punishment',
          mode: 'hardcore',
          endsAt: iso(NOW + 20 * MIN),
          reason: 'Castigo',
          serviceIds: [],
          domains: [],
          whitelistOnly: true,
        },
      ],
      whitelist: { allowDomains: ['wikipedia.org'], allowHostPatterns: ['^docs\\.google\\.com$'] },
      punishment: { endsAt: iso(NOW + 20 * MIN), level: 'whitelist' },
    });
    const during = pruneRules(rules, NOW + 10 * MIN);
    expect(during.whitelist).not.toBeNull();
    const after = pruneRules(rules, NOW + 21 * MIN);
    expect(after.whitelist).toBeNull();
    expect(after.punishment).toBeNull();
    expect(after.blocks.map((b) => b.id)).toEqual([BLK_A]);
    expect(after.blockDomains).toEqual(YOUTUBE_HOSTS);
  });

  it('closes the whitelist exemption of an ended allowance', () => {
    const rules = rulesFixture({
      blockDomains: [],
      blocks: [
        {
          id: BLK_W,
          kind: 'manual',
          mode: 'strict',
          endsAt: iso(NOW + 60 * MIN),
          reason: 'Examen',
          serviceIds: [],
          domains: [],
          whitelistOnly: true,
        },
      ],
      whitelist: { allowDomains: ['wikipedia.org', ...YOUTUBE_HOSTS], allowHostPatterns: [] },
      allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 5 * MIN) }],
    });
    const pruned = pruneRules(rules, NOW + 6 * MIN);
    expect(pruned.whitelist?.allowDomains).toEqual(['wikipedia.org']);
  });

  it('never ends a block whose end time cannot be read', () => {
    const rules = rulesFixture();
    rules.blocks[0]!.endsAt = 'not-a-time';
    expect(pruneRules(rules, NOW + 1_000 * MIN).blocks).toHaveLength(1);
  });
});

describe('mergeCarriedRules', () => {
  it('adds the carried blocks, hosts and punishment', () => {
    const primary = rulesFixture({ blockDomains: [], blocks: [], nextChangeAt: null });
    const carried = twoBlocks();
    carried.punishment = { endsAt: iso(NOW + 90 * MIN), level: 'distractions' };
    const merged = mergeCarriedRules(primary, carried);
    expect(merged.blocks.map((b) => b.id)).toEqual([BLK_A, BLK_B]);
    expect(new Set(merged.blockDomains)).toEqual(new Set([...YOUTUBE_HOSTS, ...TIKTOK_HOSTS]));
    expect(merged.punishment?.level).toBe('distractions');
    expect(merged.nextChangeAt).toBe(iso(NOW + 30 * MIN));
    expect(merged.extRulesVersion).toBe(primary.extRulesVersion);
  });

  it('intersects two whitelists and keeps the stricter punishment', () => {
    const primary = rulesFixture({
      whitelist: { allowDomains: ['wikipedia.org', 'khanacademy.org'], allowHostPatterns: ['^a$'] },
      punishment: { endsAt: iso(NOW + 10 * MIN), level: 'nuclear' },
    });
    const carried = rulesFixture({
      whitelist: { allowDomains: ['wikipedia.org'], allowHostPatterns: [] },
      punishment: { endsAt: iso(NOW + 40 * MIN), level: 'whitelist' },
    });
    const merged = mergeCarriedRules(primary, carried);
    expect(merged.whitelist).toEqual({ allowDomains: ['wikipedia.org'], allowHostPatterns: [] });
    expect(merged.punishment).toEqual({ endsAt: iso(NOW + 40 * MIN), level: 'nuclear' });
  });

  it('is a no-op without carried blocks', () => {
    const primary = rulesFixture();
    expect(mergeCarriedRules(primary, rulesFixture({ blocks: [] }))).toBe(primary);
  });
});

describe('mergeCarriedRules exemptions', () => {
  /** A hardcore YouTube block verified under the old pairing. */
  const carriedYoutube = (): ExtRulesResponse =>
    rulesFixture({
      blocks: [{ ...rulesFixture().blocks[0]!, mode: 'hardcore', endsAt: iso(NOW + 90 * MIN) }],
    });
  /** An exam (whitelist only) verified under the old pairing. */
  const carriedExam = (): ExtRulesResponse =>
    rulesFixture({
      blockDomains: [],
      excludedDomains: [],
      whitelist: { allowDomains: ['wikipedia.org'], allowHostPatterns: [] },
      blocks: [
        {
          id: BLK_W,
          kind: 'manual',
          mode: 'exam',
          endsAt: iso(NOW + 90 * MIN),
          reason: 'Examen',
          serviceIds: [],
          domains: [],
          whitelistOnly: true,
        },
      ],
    });
  /** What a fake guardian on another port signs with its own key after a new pairing. */
  const fakePrimary = (excludedDomains: string[]): ExtRulesResponse =>
    rulesFixture({
      extRulesVersion: 1,
      blockDomains: [],
      blocks: [],
      excludedDomains,
      nextChangeAt: null,
    });
  const verdict = (rules: ExtRulesResponse, url: string) =>
    evaluateDnr(buildDnrRules(rules).rules, url);

  it('a new pairing cannot exempt a host the carried rules block', () => {
    const effective = computeEffectiveRules(
      record(fakePrimary(['youtube.com', 'm.youtube.com', 'tiktok.com']), carriedYoutube()),
      NOW,
      true,
    )!;
    expect(effective.excludedDomains).not.toContain('youtube.com');
    expect(effective.excludedDomains).not.toContain('m.youtube.com');
    // A host no carried rule restricts may still be exempt.
    expect(effective.excludedDomains).toContain('tiktok.com');
    for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com']) {
      expect(matchHost(effective, host)).toMatchObject({ blocked: true, via: 'domain' });
      expect(verdict(effective, `https://${host}/watch?v=1`)).toMatchObject({
        action: 'redirect',
      });
    }
  });

  it('a new pairing cannot exempt a parent of a carried blocked host', () => {
    const carried = rulesFixture({
      blockDomains: ['m.youtube.com'],
      blocks: [{ ...rulesFixture().blocks[0]!, domains: ['m.youtube.com'] }],
    });
    const effective = mergeCarriedRules(fakePrimary(['youtube.com']), carried);
    expect(effective.excludedDomains).not.toContain('youtube.com');
    expect(matchHost(effective, 'm.youtube.com').blocked).toBe(true);
    expect(verdict(effective, 'https://m.youtube.com/').action).toBe('redirect');
  });

  it('a new pairing cannot punch through a carried whitelist', () => {
    const effective = computeEffectiveRules(
      record(fakePrimary(['reddit.com', 'es.wikipedia.org']), carriedExam()),
      NOW,
      true,
    )!;
    expect(effective.excludedDomains).toEqual(['es.wikipedia.org']);
    expect(matchHost(effective, 'reddit.com')).toMatchObject({ blocked: true, via: 'whitelist' });
    expect(verdict(effective, 'https://www.reddit.com/').action).toBe('redirect');
    expect(matchHost(effective, 'es.wikipedia.org').blocked).toBe(false);
    expect(verdict(effective, 'https://es.wikipedia.org/').action).toBe('allow');
  });

  it('carried exemptions cannot open a host the new rules block either', () => {
    const carried = rulesFixture({
      blockDomains: TIKTOK_HOSTS,
      excludedDomains: ['youtube.com'],
      blocks: [{ ...twoBlocks().blocks[1]! }],
    });
    const effective = mergeCarriedRules(rulesFixture(), carried);
    expect(effective.excludedDomains).toEqual(['accounts.youtube.com']);
    expect(matchHost(effective, 'www.youtube.com').blocked).toBe(true);
    expect(verdict(effective, 'https://www.youtube.com/').action).toBe('redirect');
  });

  it('keeps exemptions both sides share and always-allowed hosts', () => {
    const effective = mergeCarriedRules(
      fakePrimary(['accounts.youtube.com', 'studio.youtube.com']),
      carriedYoutube(),
    );
    // accounts.youtube.com: exempt under the old rules too (and always allowed).
    expect(effective.excludedDomains).toEqual(['accounts.youtube.com']);
    expect(matchHost(effective, 'accounts.youtube.com').blocked).toBe(false);
    expect(verdict(effective, 'https://accounts.youtube.com/').action).toBe('allow');
    expect(matchHost(effective, 'studio.youtube.com').blocked).toBe(true);
  });
});

describe('closeEndedAllowances', () => {
  const withAllowance = (endsAt: number): ExtRulesResponse =>
    rulesFixture({
      // The guardian subtracted YouTube while the allowance runs.
      blockDomains: [],
      allowances: [{ serviceId: 'youtube', endsAt: iso(endsAt) }],
      nextChangeAt: iso(endsAt),
    });

  it('closes an ended allowance even while the guardian is trusted', () => {
    // A bare 304 kept the link «connected» after the allowance ended.
    const rules = withAllowance(NOW - 30 * MIN);
    const trusted = computeEffectiveRules(record(rules), NOW, true)!;
    expect(trusted.allowances).toEqual([]);
    expect(new Set(trusted.blockDomains)).toEqual(new Set(YOUTUBE_HOSTS));
    expect(matchHost(trusted, 'www.youtube.com').blocked).toBe(true);
    expect(trusted.nextChangeAt).toBe(iso(NOW + 30 * MIN));
    // The same as without the guardian.
    const untrusted = computeEffectiveRules(record(rules), NOW, false)!;
    expect(matchHost(untrusted, 'www.youtube.com').blocked).toBe(true);
  });

  it('keeps a live allowance open and the signed blocks as they are', () => {
    const rules = withAllowance(NOW + 10 * MIN);
    expect(closeEndedAllowances(rules, NOW)).toBe(rules);
    expect(matchHost(computeEffectiveRules(record(rules), NOW, true), 'youtube.com').blocked).toBe(
      false,
    );
    // Boot hold: an ended block stays while trusted; only the allowance closes.
    const held = withAllowance(NOW - MIN);
    held.blocks[0]!.endsAt = iso(NOW - MIN);
    const effective = closeEndedAllowances(held, NOW);
    expect(effective.blocks.map((b) => b.id)).toEqual([BLK_A]);
    expect(matchHost(effective, 'youtube.com').blocked).toBe(true);
  });
});

describe('computeEffectiveRules', () => {
  it('uses the signed body as is while the guardian answers (boot hold)', () => {
    const rules = rulesFixture();
    rules.blocks[0]!.endsAt = iso(NOW - MIN); // ended, but the guardian still sends it
    expect(computeEffectiveRules(record(rules), NOW, true)).toBe(rules);
    expect(computeEffectiveRules(record(rules), NOW, false)?.blocks).toEqual([]);
    expect(computeEffectiveRules(null, NOW, true)).toBeNull();
  });

  it('prunes carried rules even while connected', () => {
    const carried = twoBlocks();
    const effective = computeEffectiveRules(
      record(rulesFixture({ blockDomains: [], blocks: [] }), carried),
      NOW + 31 * MIN,
      true,
    );
    expect(effective?.blocks.map((b) => b.id)).toEqual([BLK_B]);
    expect(effective?.blockDomains).toEqual(TIKTOK_HOSTS);
  });

  it('trusts rules only while unknown or connected', () => {
    expect(linkTrustsRules('unknown')).toBe(true);
    expect(linkTrustsRules('connected')).toBe(true);
    for (const link of ['unreachable', 'unauthorized', 'untrusted', 'error'] as const) {
      expect(linkTrustsRules(link)).toBe(false);
    }
  });
});

describe('nextRulesChangeAt', () => {
  it('is the earliest future end across rules, carried rules and allowances', () => {
    const rules = twoBlocks();
    rules.allowances = [{ serviceId: 'instagram', endsAt: iso(NOW + 12 * MIN) }];
    expect(nextRulesChangeAt(record(rules), NOW)).toBe(NOW + 12 * MIN);
    expect(nextRulesChangeAt(record(rules), NOW + 13 * MIN)).toBe(NOW + 30 * MIN);
    const carried = rulesFixture();
    carried.blocks[0]!.endsAt = iso(NOW + 5 * MIN);
    expect(nextRulesChangeAt(record(rules, carried), NOW)).toBe(NOW + 5 * MIN);
    expect(nextRulesChangeAt(record(rules), NOW + 91 * MIN)).toBeNull();
    expect(nextRulesChangeAt(null, NOW)).toBeNull();
  });
});

describe('matchHost', () => {
  const rules = twoBlocks();

  it('follows the DNR priorities: excluded, blocked (with subdomains), allowed', () => {
    expect(matchHost(rules, 'www.youtube.com')).toMatchObject({ blocked: true, via: 'domain' });
    expect(matchHost(rules, 'www.youtube.com').block?.id).toBe(BLK_A);
    expect(matchHost(rules, 'es.m.youtube.com').blocked).toBe(true);
    expect(matchHost(rules, 'accounts.youtube.com').blocked).toBe(false);
    expect(matchHost(rules, 'notyoutube.com').blocked).toBe(false);
    expect(matchHost(rules, 'localhost').blocked).toBe(false);
    expect(matchHost(null, 'youtube.com').blocked).toBe(false);
  });

  it('picks the covering block with the latest end', () => {
    const r = twoBlocks();
    r.blocks[1]!.domains.push('youtube.com');
    expect(matchHost(r, 'youtube.com').block?.id).toBe(BLK_B);
  });

  it('blocks everything but the whitelist while one is set', () => {
    const r = rulesFixture({
      blocks: [
        ...rulesFixture().blocks,
        {
          id: BLK_W,
          kind: 'manual',
          mode: 'hardcore',
          endsAt: iso(NOW + 60 * MIN),
          reason: 'Examen',
          serviceIds: [],
          domains: [],
          whitelistOnly: true,
        },
      ],
      whitelist: {
        allowDomains: ['wikipedia.org', 'youtube.com'],
        allowHostPatterns: ['^[a-z]+\\.moodle\\.org$'],
      },
    });
    expect(matchHost(r, 'es.wikipedia.org').blocked).toBe(false);
    expect(matchHost(r, 'campus.moodle.org').blocked).toBe(false);
    expect(matchHost(r, 'reddit.com')).toMatchObject({ blocked: true, via: 'whitelist' });
    expect(matchHost(r, 'reddit.com').block?.id).toBe(BLK_W);
    // A whitelist entry never reopens a host another block lists.
    expect(matchHost(r, 'youtube.com')).toMatchObject({ blocked: true, via: 'domain' });
  });
});

describe('buildSnapshot', () => {
  const base = {
    now: NOW,
    status: { ...EMPTY_STATUS },
    browser: { family: 'chrome' as const, engine: 'chromium' as const, version: '131.0.0.0' },
    capabilities: { hostPermission: true, incognitoAllowed: true },
    extVersion: '0.1.0',
  };

  it('asks to pair when there is no pairing', () => {
    const snap = buildSnapshot({ ...base, pairing: null, record: null, link: 'unknown' });
    expect(snap.paired).toBe(false);
    expect(snap.protection).toBe('off');
    expect(snap.problems).toEqual(['not_paired']);
    expect(snap.rules).toBeNull();
  });

  it('shows the cached rules when the guardian does not answer, without the token', () => {
    const snap = buildSnapshot({
      ...base,
      pairing: pairingFixture(KEY),
      record: record(twoBlocks()),
      link: 'unreachable',
    });
    expect(snap.protection).toBe('cached');
    expect(snap.problems).toEqual(['guardian_unreachable']);
    expect(snap.rules?.blocks.map((b) => b.id)).toEqual([BLK_B, BLK_A]);
    expect(snap.rules?.blockedHostCount).toBe(YOUTUBE_HOSTS.length + TIKTOK_HOSTS.length);
    expect(JSON.stringify(snap)).not.toContain('cte_');
  });

  it('lists permission, incognito, revocation and heartbeat problems', () => {
    const snap = buildSnapshot({
      ...base,
      capabilities: { hostPermission: false, incognitoAllowed: false },
      pairing: pairingFixture(KEY, { unauthorizedAt: NOW }),
      record: record(rulesFixture()),
      status: {
        ...EMPTY_STATUS,
        heartbeatError: { code: 'browser_mismatch', status: 403, at: NOW },
      },
      link: 'unauthorized',
    });
    expect(snap.problems).toEqual([
      'unauthorized',
      'host_permission_missing',
      'browser_mismatch',
      'incognito_not_allowed',
    ]);
    expect(snap.protection).toBe('limited');
    expect(snap.needsHostPermission).toBe(true);
  });

  it('is active and problem-free when connected', () => {
    const snap = buildSnapshot({
      ...base,
      pairing: pairingFixture(KEY),
      record: record(rulesFixture()),
      link: 'connected',
    });
    expect(snap.protection).toBe('active');
    expect(snap.problems).toEqual([]);
    expect(snap.pairing?.extensionId).toBe(EXT_1);
  });
});

describe('parseBackgroundRequest', () => {
  it('accepts the four requests', () => {
    expect(parseBackgroundRequest({ type: 'centrate/get-state' })).toEqual({
      type: 'centrate/get-state',
    });
    expect(parseBackgroundRequest({ type: 'centrate/refresh' })).toEqual({
      type: 'centrate/refresh',
    });
    expect(parseBackgroundRequest({ type: 'centrate/pair', code: '048 392', port: 47601 })).toEqual(
      { type: 'centrate/pair', code: '048 392', port: 47601 },
    );
    expect(parseBackgroundRequest({ type: 'centrate/open-guide', section: 'incognito' })).toEqual({
      type: 'centrate/open-guide',
      section: 'incognito',
    });
    expect(parseBackgroundRequest({ type: 'centrate/open-guide' })).toEqual({
      type: 'centrate/open-guide',
    });
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      'centrate/get-state',
      [],
      { type: 'centrate/get-state', extra: 1 },
      { type: 'centrate/pair' },
      { type: 'centrate/pair', code: 48392 },
      { type: 'centrate/pair', code: '1'.repeat(40) },
      { type: 'centrate/pair', code: '048392', port: '47600' },
      { type: 'centrate/open-guide', section: 'javascript:alert(1)' },
      { type: 'centrate/unknown' },
    ]) {
      expect(parseBackgroundRequest(value)).toBeNull();
    }
  });
});
