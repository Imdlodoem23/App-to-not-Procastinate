/** Fixtures for the page tests: background snapshots, live blocks and blocked-tab info. */
import type { ExtRuleBlock } from '@centrate/shared/guardian-api';
import type { BlockedTabInfo } from '../../src/background/rules';
import type { ExtensionStateSnapshot } from '../../src/background/state';

export const MIN = 60_000;
export const NOW = Date.parse('2026-09-28T15:00:00Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export function ruleBlock(over: Partial<ExtRuleBlock> = {}): ExtRuleBlock {
  return {
    id: 'blk_youtube',
    kind: 'manual',
    mode: 'strict',
    endsAt: iso(NOW + 43 * MIN),
    reason: 'Aprobar mates',
    serviceIds: ['youtube'],
    domains: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    whitelistOnly: false,
    ...over,
  };
}

type SnapshotOverrides = Partial<Omit<ExtensionStateSnapshot, 'rules'>> & {
  blocks?: ExtRuleBlock[];
  allowances?: Array<{ serviceId: string; endsAt: string }>;
  punishment?: NonNullable<ExtensionStateSnapshot['rules']>['punishment'];
  rules?: null;
};

export function snapshot(over: SnapshotOverrides = {}): ExtensionStateSnapshot {
  const { blocks, allowances, punishment, rules, ...top } = over;
  return {
    v: 1,
    now: NOW,
    paired: true,
    pairing: {
      extensionId: 'ext_1',
      guardianVersion: '0.1.0',
      browser: 'chrome',
      port: 47600,
      pairedAt: NOW - 60 * MIN,
    },
    link: 'connected',
    protection: 'active',
    problems: [],
    browser: { family: 'chrome', engine: 'chromium', version: '131.0' },
    capabilities: { hostPermission: true, incognitoAllowed: true },
    needsHostPermission: false,
    extVersion: '0.1.0',
    rules:
      rules === null
        ? null
        : {
            extRulesVersion: 3,
            blocks: blocks ?? [ruleBlock()],
            allowances: allowances ?? [],
            punishment: punishment ?? null,
            whitelistActive: false,
            penaltiesEnabled: true,
            nextChangeAt: null,
            blockedHostCount: 4,
            receivedAt: NOW - 1_000,
          },
    lastRulesAt: NOW - 1_000,
    lastHeartbeatAt: NOW - 1_000,
    lastError: null,
    ...top,
  };
}

export function tabInfo(over: Partial<BlockedTabInfo> = {}): BlockedTabInfo {
  return {
    v: 1,
    tabId: 7,
    host: 'www.youtube.com',
    url: 'https://www.youtube.com/watch?v=1',
    serviceId: 'youtube',
    cause: 'domain',
    status: 'counted',
    at: NOW + 50,
    pointsDelta: -10,
    episodePointsDelta: -10,
    nextPenalty: 20,
    penaltiesEnabled: true,
    guardianReason: null,
    block: {
      id: 'blk_youtube',
      kind: 'manual',
      mode: 'strict',
      endsAt: iso(NOW + 43 * MIN),
      reason: 'Aprobar mates',
    },
    ...over,
  };
}
