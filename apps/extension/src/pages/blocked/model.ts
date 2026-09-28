/**
 * blocked.html, pure part (PROMPT §6 and §10): what the page shows from
 * - its query string (`?cause=…&service=…&tab=1`, display only: any page can open it),
 * - the attempt info the background wrote for its tab (`BlockedTabInfo`, background/rules.ts),
 * - the background snapshot (live blocks: an extended block shows its new end at once).
 *
 * PROMPT §10 lists no big countdown here: the header «quedan 43 min» is the only time, and
 * the humor line uses the same whole minutes (both rounded up).
 *
 * Three phases (shared/phase.ts `endPhase`, the popup's rule too): `blocked`; `checking`
 * once the end has passed while the extension still enforces the block (the guardian holds
 * it, docs/ARCHITECTURE.md §10.2, or its new rules have not arrived: «Comprobando la hora…»,
 * like the app); and `ended`, when nothing covers the site any more («Abrir YouTube» reopens
 * the page the attempt wanted). The live region says «Bloqueo terminado» only on the move
 * to `ended`.
 *
 * The page never reports attempts (docs/ARCHITECTURE.md §9.5): the background does, and
 * the page shows the result («−10 puntos») when it has one; if unknown, nothing.
 */
import { getService } from '@centrate/shared/catalog';
import type { BlockKind, BlockMode } from '@centrate/shared/domain';
import type { ExtRuleBlock } from '@centrate/shared/guardian-api';
import type { BlockedPageParams, BlockedTabBlock, BlockedTabInfo } from '../../background/rules';
import type { ExtensionStateSnapshot } from '../../background/state';
import { PAGES_ES } from '../i18n/es';
import type { BlockedSite } from '../shared/blocks';
import { blockCovers, displayHost, latestCovering } from '../shared/blocks';
import {
  countdownAria,
  formatPoints,
  formatRemaining,
  formatRemainingProse,
  nextMinuteDelay,
  parseIso,
} from '../shared/format';
import type { AnnounceInput } from '../shared/phase';
import { endPhase } from '../shared/phase';

/**
 * Info written up to this long before the page loaded still belongs to it (the background
 * writes it just before moving an open tab here); older info is from an earlier page in the
 * same tab, unless this load is a reload or a history navigation of the same page.
 */
export const INFO_FRESH_MS = 30_000;

export interface InfoContext {
  /** This page's tab (`chrome.tabs.getCurrent()`); `null` when unknown. */
  tabId: number | null;
  params: BlockedPageParams;
  /** `performance.timeOrigin`. */
  loadedAt: number;
  /** `PerformanceNavigationTiming.type` («navigate», «reload», «back_forward»…). */
  navigationType: string | null;
}

/** Whether `info` describes the attempt that opened this page. */
export function isCurrentInfo(
  info: BlockedTabInfo | null,
  ctx: InfoContext,
): info is BlockedTabInfo {
  if (info === null || ctx.tabId === null || info.tabId !== ctx.tabId) return false;
  if (info.cause !== ctx.params.cause) return false;
  if (
    ctx.params.serviceId !== null &&
    info.serviceId !== null &&
    info.serviceId !== ctx.params.serviceId
  ) {
    return false;
  }
  const revisit = ctx.navigationType === 'reload' || ctx.navigationType === 'back_forward';
  return revisit || info.at >= ctx.loadedAt - INFO_FRESH_MS;
}

export interface BlockedSubject {
  /** Starts a sentence: «YouTube», «reddit.com», «Esta web». */
  name: string;
  /** Inside a sentence: «YouTube», «reddit.com», «esta web». */
  inlineName: string;
  known: boolean;
}

/** The site's name: its catalog service, else its host, else «Esta web». */
export function blockedSubject(
  params: BlockedPageParams,
  info: BlockedTabInfo | null,
): BlockedSubject {
  const serviceId = info?.serviceId ?? params.serviceId;
  const service = serviceId !== null ? getService(serviceId) : undefined;
  if (service !== undefined) return { name: service.name, inlineName: service.name, known: true };
  if (info?.host) {
    const host = displayHost(info.host);
    return { name: host, inlineName: host, known: true };
  }
  const b = PAGES_ES.blocked;
  return { name: b.unknownName, inlineName: b.unknownInlineName, known: false };
}

/** The block the page shows: when access returns, and «tu motivo». */
export interface ShownBlock {
  endsAt: number | null;
  reason: string | null;
  mode: BlockMode;
  kind: BlockKind;
}

type BlockLike = BlockedTabBlock | ExtRuleBlock;

/** The site the page replaced, from the attempt info or else the query string. */
function blockedSite(params: BlockedPageParams, info: BlockedTabInfo | null): BlockedSite {
  return {
    cause: info?.cause ?? params.cause,
    serviceId: info?.serviceId ?? params.serviceId,
    host: info?.host ?? null,
  };
}

function toShown(block: BlockLike): ShownBlock {
  const reason = block.reason.trim();
  return {
    endsAt: parseIso(block.endsAt),
    reason: reason.length > 0 ? reason : null,
    mode: block.mode,
    kind: block.kind,
  };
}

/**
 * The block that ends last among: the attempt's covering block (in its live version from
 * the snapshot when there is one: blocks can only get longer) and the live blocks that
 * cover the site. A whitelist page with no whitelist block falls back to the punishment.
 */
export function shownBlock(
  params: BlockedPageParams,
  info: BlockedTabInfo | null,
  snapshot: ExtensionStateSnapshot | null,
): ShownBlock | null {
  const live = snapshot?.rules?.blocks ?? [];
  const site = blockedSite(params, info);
  const candidates: BlockLike[] = [];
  if (info?.block) {
    const id = info.block.id;
    candidates.push(live.find((b) => b.id === id) ?? info.block);
  }
  const covering = latestCovering(live, site);
  if (covering !== null) candidates.push(covering);

  let best: BlockLike | null = null;
  let bestEnd = -Infinity;
  for (const block of candidates) {
    const end = parseIso(block.endsAt) ?? Infinity;
    if (best === null || end > bestEnd) {
      best = block;
      bestEnd = end;
    }
  }
  if (best !== null) return toShown(best);

  const punishment = snapshot?.rules?.punishment ?? null;
  if (site.cause === 'whitelist' && punishment !== null) {
    return {
      endsAt: parseIso(punishment.endsAt),
      reason: null,
      mode: 'hardcore',
      kind: 'punishment',
    };
  }
  return null;
}

/**
 * Whether the extension may still redirect the site although the shown block's end has
 * passed: the snapshot is not known yet, or it still lists a block over the site (the
 * attempt's block or any covering one) or, for a whitelist page, the punishment. While the
 * guardian answers, the background uses its signed rules as they are: it may hold an ended
 * block (boot hold) until it confirms the time, and pushes new rules when the block ends.
 */
export function stillEnforced(
  params: BlockedPageParams,
  info: BlockedTabInfo | null,
  snapshot: ExtensionStateSnapshot | null,
): boolean {
  if (snapshot === null) return true;
  const rules = snapshot.rules;
  if (rules === null) return false;
  const site = blockedSite(params, info);
  const attemptBlock = info?.block?.id ?? null;
  if (rules.blocks.some((b) => b.id === attemptBlock || blockCovers(b, site))) return true;
  return site.cause === 'whitelist' && rules.punishment !== null;
}

/**
 * The page the attempt wanted, to reopen once its block has ended: only an `http(s)` URL
 * from the background's info, and only when no whitelist is active (it might redirect the
 * site again, as a new attempt). `null` otherwise: «Volver a lo mío» stays.
 */
export function reopenUrl(
  info: BlockedTabInfo | null,
  snapshot: ExtensionStateSnapshot | null,
): string | null {
  if (info?.url == null || snapshot === null || snapshot.rules?.whitelistActive === true) {
    return null;
  }
  try {
    const url = new URL(info.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The points line: the attempt's cost in red, or a grey fact. */
export interface PointsLine {
  text: string;
  tone: 'red' | 'muted';
  /** Grey line under it («Es el mismo intento…»). */
  note: string | null;
}

/**
 * From the attempt info: `pending` while the guardian answers (the line keeps its height),
 * `null` when there is nothing to say (unknown, not counted, penalties off).
 */
export function pointsLine(info: BlockedTabInfo | null): PointsLine | 'pending' | null {
  if (info === null) return null;
  const b = PAGES_ES.blocked;
  switch (info.status) {
    case 'reporting':
      return 'pending';
    case 'counted':
      return info.pointsDelta !== null && info.pointsDelta < 0
        ? { text: formatPoints(info.pointsDelta), tone: 'red', note: null }
        : null;
    case 'merged':
    case 'ignored':
      return info.episodePointsDelta !== null && info.episodePointsDelta < 0
        ? { text: formatPoints(info.episodePointsDelta), tone: 'red', note: b.sameAttempt }
        : null;
    case 'enforced':
      return { text: b.enforced, tone: 'muted', note: null };
    case 'not_counted':
    case 'unreported':
      return null;
  }
}

/** The grey humor line (PROMPT §10: humor only here and in empty states). */
export function humorLine(
  index: number,
  input: {
    subject: BlockedSubject;
    remainingMs: number | null;
    cause: 'domain' | 'whitelist';
    /** Mode of the block shown (`exam` has its own whitelist line). */
    mode: BlockMode | null;
  },
): string {
  const b = PAGES_ES.blocked;
  if (input.remainingMs !== null && input.remainingMs <= 0) return b.endedLine;
  const pick = <T>(lines: readonly T[]): T => {
    const i = ((Math.trunc(index) % lines.length) + lines.length) % lines.length;
    return lines[i] as T;
  };
  if (input.cause === 'whitelist') return input.mode === 'exam' ? b.examLine : b.whitelistLine;
  const context = {
    name: input.subject.name,
    inlineName: input.subject.inlineName,
    time: input.remainingMs === null ? null : formatRemainingProse(input.remainingMs),
  };
  const lines = b.humor.map((line) => line(context)).filter((l): l is string => l !== null);
  return pick(lines);
}

export type BackAction = 'history' | 'newtab';

/**
 * «Volver a lo mío»: back in history only when the previous entry cannot be the blocked site
 * itself. When the extension moved this tab here (a tab already open when the block
 * started, `tab=1`, or the safety net for a blocked page that loaded anyway: the background
 * wrote the info before this page started loading), the previous entry *is* the blocked
 * site, so a new tab page replaces this one instead.
 */
export function backAction(input: {
  historyLength: number;
  params: BlockedPageParams;
  info: BlockedTabInfo | null;
  loadedAt: number;
}): BackAction {
  const { info } = input;
  const moved =
    input.params.enforced ||
    info?.status === 'enforced' ||
    (info !== null && info.at < input.loadedAt);
  return input.historyLength > 1 && !moved ? 'history' : 'newtab';
}

export interface BlockedViewInput {
  params: BlockedPageParams;
  /** Current info only (`isCurrentInfo`), `null` otherwise and inside a frame. */
  info: BlockedTabInfo | null;
  snapshot: ExtensionStateSnapshot | null;
  now: number;
  /** Random per load: which humor line. */
  humorIndex: number;
  /** False until the first answers arrived (the humor line waits, so it never swaps). */
  ready: boolean;
}

/**
 * `blocked`: the block runs (or its end is unknown). `checking`: its end has passed but the
 * extension may still enforce it. `ended`: nothing covers the site any more.
 */
export type BlockedPhase = 'blocked' | 'checking' | 'ended';

/** The single tile: «Volver a lo mío», or «Abrir YouTube» once the block has ended. */
export type BlockedAction = { kind: 'back' } | { kind: 'open'; url: string };

export interface BlockedView {
  documentTitle: string;
  phase: BlockedPhase;
  /** «YouTube: bloqueado», «YouTube: bloqueo terminado». */
  title: string;
  /** «quedan 43 min», «Comprobando la hora…»; `null` without a known end or once it ended. */
  headerValue: string | null;
  /** `role="timer"` label of the header value («Quedan 43 minutos»); `null` when not counting. */
  remainingLabel: string | null;
  remainingMs: number | null;
  reason: string | null;
  points: PointsLine | 'pending' | null;
  humor: string;
  action: BlockedAction;
  /** «Volver a lo mío», «Abrir YouTube». */
  actionLabel: string;
  /** Delay until the next visible change (the next whole minute; `null`: none). */
  nextTickMs: number | null;
  /**
   * What the live region follows: the minutes while counting, silence while checking (or
   * before the first answers and the snapshot), and the end once the phase is `ended`.
   */
  announce: AnnounceInput;
}

/** blocked.html shows one site: its live region follows one key. */
const SITE_KEY = 'site';

export function blockedView(input: BlockedViewInput): BlockedView {
  const { params, info, snapshot, now } = input;
  const b = PAGES_ES.blocked;
  const subject = blockedSubject(params, info);
  const block = shownBlock(params, info, snapshot);
  const endsAt = block?.endsAt ?? null;
  const remainingMs = endsAt === null ? null : Math.max(0, endsAt - now);
  const timePhase = endPhase(endsAt, now, endsAt !== null && stillEnforced(params, info, snapshot));
  const phase: BlockedPhase = timePhase === 'running' ? 'blocked' : timePhase;
  const counting = remainingMs !== null && remainingMs > 0;

  let title: string;
  if (phase === 'ended') title = subject.known ? b.titleEnded(subject.name) : b.titleEndedUnknown;
  else title = subject.known ? b.title(subject.name) : b.titleUnknown;

  let headerValue: string | null = null;
  if (counting) headerValue = formatRemaining(remainingMs);
  else if (phase === 'checking') headerValue = b.checking;

  let humor = '';
  if (input.ready) {
    if (phase === 'checking') humor = b.checkingLine(subject.inlineName);
    else if (phase === 'ended') humor = b.endedLine;
    else {
      humor = humorLine(input.humorIndex, {
        subject,
        remainingMs,
        cause: info?.cause ?? params.cause,
        mode: block?.mode ?? null,
      });
    }
  }

  let announce: AnnounceInput = { kind: 'none' };
  if (input.ready) {
    if (phase === 'ended') announce = { kind: 'ended' };
    // Held with a known snapshot; before it arrives nothing is known yet (`none`), so a page
    // loaded after the end never announces «Bloqueo terminado» when the snapshot lands.
    else if (phase === 'checking' && snapshot !== null)
      announce = { kind: 'checking', key: SITE_KEY };
    else if (counting) announce = { kind: 'counting', key: SITE_KEY, remainingMs };
  }

  const url = phase === 'ended' ? reopenUrl(info, snapshot) : null;
  const action: BlockedAction = url === null ? { kind: 'back' } : { kind: 'open', url };
  return {
    documentTitle: b.documentTitle(title),
    phase,
    title,
    headerValue,
    remainingLabel: counting ? countdownAria(remainingMs) : null,
    remainingMs,
    // Once it has ended, the reason and the points belong to a block that is over.
    reason: phase === 'ended' ? null : (block?.reason ?? null),
    points: phase === 'ended' ? null : pointsLine(info),
    humor,
    action,
    actionLabel: action.kind === 'open' ? b.open(subject.name) : b.back,
    nextTickMs: remainingMs === null ? null : nextMinuteDelay(remainingMs),
    announce,
  };
}
