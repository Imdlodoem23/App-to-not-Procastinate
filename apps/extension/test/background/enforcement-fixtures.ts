// Fixtures for the DNR mapping and attempt tests, and a small declarativeNetRequest
// evaluator that follows the browsers' matching rules closely enough to check behaviour:
// highest priority wins; on a tie allow > allowAllRequests > block > upgradeScheme >
// redirect; `requestDomains` matches subdomains; no `resourceTypes` means every type but
// main_frame.
import type { AttemptResponse, ExtRulesResponse } from '@centrate/shared/guardian-api';
import type { DnrRule, DnrRuleSpec } from '../../src/background/rules';

export const MIN = 60_000;
export const NOW = Date.parse('2026-09-28T10:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export const BLK_YT = 'blk_0123456789abcdefYTYT' as const;
export const BLK_CUSTOM = 'blk_0123456789abcdefCUST' as const;
export const BLK_EXAM = 'blk_0123456789abcdefEXAM' as const;
export const ATT_1 = 'att_0123456789abcdef0001' as const;

export const YOUTUBE = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];
export const INSTAGRAM = ['instagram.com', 'www.instagram.com', 'cdninstagram.com'];
export const TIKTOK = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'];
export const CUSTOM = ['example.org', 'www.example.org'];

/** A strict block on YouTube + Instagram and a normal one on a custom domain. */
export function blockRules(overrides: Partial<ExtRulesResponse> = {}): ExtRulesResponse {
  return {
    extRulesVersion: 1_790_000_000_057,
    nonce: 'q3Jd0W3y8kqj3n7mW2Wm8A',
    serverNow: iso(NOW),
    blockDomains: [...YOUTUBE, ...INSTAGRAM, ...CUSTOM],
    excludedDomains: ['accounts.youtube.com'],
    whitelist: null,
    blocks: [
      {
        id: BLK_YT,
        kind: 'manual',
        mode: 'strict',
        endsAt: iso(NOW + 60 * MIN),
        reason: 'Quiero aprobar mates',
        serviceIds: ['youtube', 'instagram'],
        domains: [...YOUTUBE, ...INSTAGRAM],
        whitelistOnly: false,
      },
      {
        id: BLK_CUSTOM,
        kind: 'manual',
        mode: 'normal',
        endsAt: iso(NOW + 30 * MIN),
        reason: '',
        serviceIds: [],
        domains: [...CUSTOM],
        whitelistOnly: false,
      },
    ],
    allowances: [],
    punishment: null,
    nextChangeAt: iso(NOW + 30 * MIN),
    penaltiesEnabled: true,
    ...overrides,
  };
}

/** An exam block (whitelist only) plus the YouTube block: YouTube stays blocked even if allowed. */
export function examRules(overrides: Partial<ExtRulesResponse> = {}): ExtRulesResponse {
  return {
    extRulesVersion: 1_790_000_000_099,
    nonce: 'q3Jd0W3y8kqj3n7mW2Wm8A',
    serverNow: iso(NOW),
    blockDomains: [...YOUTUBE],
    excludedDomains: ['accounts.youtube.com'],
    whitelist: {
      allowDomains: ['wikipedia.org', 'docs.google.com', 'accounts.youtube.com', 'youtube.com'],
      allowHostPatterns: [
        '^[a-z0-9-]+-docs\\.googleusercontent\\.com$',
        '^lh[3-7](?:-[a-z]+)?\\.googleusercontent\\.com$',
        '^lh[3-7]\\.google\\.com$',
      ],
    },
    blocks: [
      {
        id: BLK_YT,
        kind: 'manual',
        mode: 'hardcore',
        endsAt: iso(NOW + 90 * MIN),
        reason: 'Sin vídeos',
        serviceIds: ['youtube'],
        domains: [...YOUTUBE],
        whitelistOnly: false,
      },
      {
        id: BLK_EXAM,
        kind: 'manual',
        mode: 'exam',
        endsAt: iso(NOW + 120 * MIN),
        reason: 'Examen de física',
        serviceIds: [],
        domains: [],
        whitelistOnly: true,
      },
    ],
    allowances: [],
    punishment: null,
    nextChangeAt: iso(NOW + 90 * MIN),
    penaltiesEnabled: true,
    ...overrides,
  };
}

export function attemptResponse(overrides: Partial<AttemptResponse> = {}): AttemptResponse {
  return {
    blocked: true,
    counted: true,
    merged: false,
    attemptId: ATT_1,
    pointsDelta: -10,
    episodePointsDelta: -10,
    escalationIndex: 0,
    nextPenalty: 20,
    serviceId: 'youtube',
    block: {
      id: BLK_YT,
      kind: 'manual',
      mode: 'strict',
      endsAt: iso(NOW + 60 * MIN),
      reason: 'Quiero aprobar mates',
    },
    reason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// DNR evaluator
// ---------------------------------------------------------------------------------------

export interface Verdict {
  action: 'none' | 'allow' | 'redirect';
  /** `extensionPath` of a redirect. */
  to?: string;
}

const ACTION_RANK: Record<string, number> = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0,
};

function matches(rule: DnrRuleSpec, url: string, type: string): boolean {
  const c = rule.condition;
  const types = c.resourceTypes ?? null;
  if (types === null ? type === 'main_frame' : !(types as string[]).includes(type)) return false;
  const host = new URL(url).hostname;
  if (c.requestDomains && !c.requestDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return false;
  }
  if (c.excludedRequestDomains?.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  if (c.regexFilter !== undefined && !new RegExp(c.regexFilter, 'i').test(url)) return false;
  if (c.urlFilter !== undefined) {
    if (c.urlFilter !== '|http') throw new Error(`unsupported urlFilter ${c.urlFilter}`);
    if (!url.startsWith('http')) return false;
  }
  return true;
}

/** What the browser would do with a request of `type` to `url`. */
export function evaluateDnr(
  rules: readonly (DnrRuleSpec | DnrRule)[],
  url: string,
  type: 'main_frame' | 'sub_frame' | 'image' | 'script' = 'main_frame',
): Verdict {
  let best: DnrRuleSpec | null = null;
  for (const rule of rules) {
    if (!matches(rule, url, type)) continue;
    if (best === null) {
      best = rule;
      continue;
    }
    const p = rule.priority ?? 1;
    const q = best.priority ?? 1;
    if (
      p > q ||
      (p === q && (ACTION_RANK[rule.action.type] ?? 0) > (ACTION_RANK[best.action.type] ?? 0))
    ) {
      best = rule;
    }
  }
  if (best === null) return { action: 'none' };
  if (best.action.type === 'allow') return { action: 'allow' };
  if (best.action.type === 'redirect') {
    return { action: 'redirect', to: best.action.redirect?.extensionPath ?? '' };
  }
  throw new Error(`unexpected action ${best.action.type}`);
}
