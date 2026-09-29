/**
 * The Recompensas window (PROMPT §7 «Tienda de recompensas», §10 «Ventanas de detalle ›
 * Recompensas»; ARCHITECTURE §8.8 «Rewards»), pure.
 *
 * - Header: «Recompensas: 1.240 puntos» (red with «Números rojos» below zero) and, on the right,
 *   the open break that ends last («YouTube hasta las 17:15»); while the guardian keeps the shop
 *   closed (Hardcore, Examen, a punishment, Study Mode, a pending emergency) «Recompensas:
 *   cerradas», the balance as the datum and why.
 * - The shop in rows: «15 min de YouTube · 150 pts · Canjear», «Canjear» with the in-place
 *   «¿Seguro?» (armed id `redeem:<offerId>`, the consequence in red on the row's help line).
 *   When it cannot be redeemed the button is disabled and the help line says why: «Te faltan
 *   40 puntos», «Como mucho 1 h de YouTube a la vez», the lock. The outcome of a redeem goes on
 *   its own line under the shop («Canjeado: YouTube abierto hasta las 17:15 · …»).
 * - Offers of services no block covers are hidden (nothing to open) and named in one line; with
 *   nothing blocked at all, the empty state points to Bloqueos.
 * - The mascot in large, with its phase and what makes it grow.
 *
 * The guardian re-checks everything on redeem; its refusals are worded here (`redeemErrorText`).
 */
import { getService, servicesInCategory } from '@centrate/shared/catalog';
import type { GuardianStateResponse, RewardsResponse } from '@centrate/shared/guardian-api';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import type { RedeemRewardResponse, RewardOfferStatus } from '@centrate/shared/guardian-api';
import { REWARDS_LOCK_REASONS } from '@centrate/shared/domain';
import type { RewardAllowance, RewardsLockReason } from '@centrate/shared/domain';
import { MASCOT_RULES, POINT_RULES, type MascotStage } from '@centrate/shared/points';
import {
  formatClock,
  formatInt,
  formatList,
  formatMinutes,
  formatPoints,
  formatPointsShort,
} from '../../../../shared/format';
import type { UiError, UiSnapshot } from '../../../../shared/ui-state';
import { mascotStageOf, minutesToGrow } from '../../components/mascot/stage';
import { errorCopy } from '../../i18n/errors';
import { RENDERER } from '../../i18n/messages';
import { RECOMPENSAS } from './i18n';

const R = RECOMPENSAS;

/** Ids shared with the component, the fixtures (`help: {row: 'rewards', item}`) and e2e. */
export const RWD_IDS = {
  root: 'rwd',
  section: 'rwd-shop',
  /** The shop's `TileRow` (its tiles are the offer ids). */
  row: 'rewards',
  retry: 'rwd-retry',
  empty: 'rwd-empty',
  /** The last redeem's outcome line. */
  result: 'rwd-result',
} as const;

/** The in-place «¿Seguro?» of an offer (docs/DESKTOP.md §15.1). */
export function redeemArmId(offerId: string): string {
  return `redeem:${offerId}`;
}

/** DOM id of an offer's name: its row's group is labelled by it («15 min de YouTube»). */
export function offerLabelId(offerId: string): string {
  return `rwd-offer-${offerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** The large mascot's side, in CSS px (PROMPT: 96–160). */
export const MASCOT_SIZE = 128;

export interface OfferRowView {
  /** The offer id (also the tile id and its help focus item). */
  id: string;
  serviceId: string;
  /** Catalog name («YouTube»). */
  service: string;
  monogram: string;
  /** «15 min de YouTube». */
  label: string;
  /** «150 pts». */
  price: string;
  /** Help on hover or focus while it can be redeemed. */
  help: string;
  /** Why «Canjear» is disabled («Te faltan 40 puntos»), `null` when it can be redeemed. */
  disabledReason: string | null;
  /** Disabled for want of points (what more blocks fix). */
  short: boolean;
  /** The armed «¿Seguro?» consequence. */
  consequence: string;
  /** Alt + this key presses its «Canjear» (the row's number: «Canjear» repeats on every row). */
  mnemonic: string;
}

export interface MascotView {
  stage: MascotStage;
  /** «Tu planta». */
  name: string;
  /** «18 min más hoy y será un árbol». */
  text: string;
}

export interface LineView {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
}

export interface RecompensasView {
  title: string;
  titleTone: 'default' | 'red';
  /** «Números rojos» or `null`. */
  pill: string | null;
  datum: string | null;
  /** Why the shop is closed, or `null`. */
  locked: string | null;
  rows: OfferRowView[];
  /** «TikTok y Twitch no están bloqueados ahora…», or `null`. */
  hidden: string | null;
  /** Nothing to show in the shop: nothing is blocked and it is not closed. */
  empty: boolean;
  /** The shop row's own help (nothing hovered): the lock, or what a reward does. */
  help: LineView;
  /**
   * The last redeem's outcome, on its own line under the shop (like Bloqueo's undo line), so
   * the help of the «Canjear» still under the pointer never hides it: «Canjeado: YouTube
   * abierto hasta las 17:15 · te quedan 1.090 puntos» in green, or the refusal in red.
   */
  result: LineView | null;
  mascot: MascotView | null;
}

export interface RecompensasInput {
  snapshot: Pick<UiSnapshot, 'state' | 'progress'>;
  /** `rewards:list`, `null` until it answered. */
  rewards: RewardsResponse | null;
  /** The last redemption (`detail.recompensas.redeemed`). */
  redeemed: RedeemRewardResponse | null;
  /** A refusal of the last redeem, worded (`redeemErrorText`). */
  notice: LineView | null;
  nowMs: number;
}

function serviceName(id: string): string {
  return getService(id)?.name ?? id;
}

function monogramOf(id: string): string {
  const service = getService(id);
  return service?.monogram ?? (service?.name ?? id).slice(0, 1).toUpperCase();
}

/** Active breaks: the guardian's (poll or shop) plus a redemption the poll has not shown yet. */
export function activeAllowances(input: RecompensasInput): RewardAllowance[] {
  const { snapshot, rewards, redeemed, nowMs } = input;
  const byId = new Map<string, RewardAllowance>();
  for (const a of [...(rewards?.allowances ?? []), ...(snapshot.state?.allowances ?? [])]) {
    byId.set(a.id, a);
  }
  if (redeemed) byId.set(redeemed.allowance.id, redeemed.allowance);
  return [...byId.values()]
    .filter((a) => a.status === 'active' && Date.parse(a.endsAt) > nowMs)
    .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt));
}

/**
 * Services the active blocks cover, as the guardian sees them in the usual cases (listed, in a
 * listed category, whitelist-only blocks cover everything). Used only while the shop is closed,
 * when the guardian answers `locked` for every offer; it decides everything else itself.
 */
export function coveredServices(state: GuardianStateResponse | null): Set<string> | 'all' {
  const covered = new Set<string>();
  for (const block of state?.blocks ?? []) {
    if (block.whitelistOnly) return 'all';
    for (const id of block.targets.serviceIds) covered.add(id);
    for (const category of block.targets.categoryIds) {
      for (const service of servicesInCategory(category)) covered.add(service.id);
    }
  }
  return covered;
}

/** The balance the shop shows: after the last redemption, else the shop's, else the poll's. */
function balanceOf(input: RecompensasInput): number | null {
  return (
    input.redeemed?.balanceAfter ??
    input.rewards?.balance ??
    input.snapshot.state?.points.balance ??
    null
  );
}

function offerRow(
  offer: RewardOfferStatus,
  index: number,
  balance: number,
  lockText: string | null,
  allowances: readonly RewardAllowance[],
  nowMs: number,
): OfferRowView {
  const service = serviceName(offer.serviceId);
  const duration = formatMinutes(offer.minutes);
  const open = allowances.find((a) => a.serviceId === offer.serviceId);
  const from = open ? Date.parse(open.endsAt) : nowMs;
  const left = formatPoints(balance - offer.cost);
  let disabledReason: string | null = null;
  let short = false;
  if (offer.unavailableReason === 'locked') disabledReason = lockText ?? R.closed;
  else if (offer.unavailableReason === 'insufficient_points' || !offer.affordable) {
    disabledReason = R.shop.short(formatPoints(Math.max(1, offer.shortBy || offer.cost - balance)));
    short = true;
  } else if (offer.unavailableReason === 'allowance_limit') {
    disabledReason = R.shop.limit(service, formatMinutes(GUARDIAN_LIMITS.allowanceMaxMinutes));
  } else if (offer.unavailableReason === 'not_blocked') {
    disabledReason = R.shop.notBlocked(service);
  }
  return {
    id: offer.offerId,
    serviceId: offer.serviceId,
    service,
    monogram: monogramOf(offer.serviceId),
    label: R.shop.offer(duration, service),
    price: formatPointsShort(offer.cost),
    help: open ? R.shop.helpExtend(duration, service, left) : R.shop.help(service, duration, left),
    disabledReason,
    short,
    consequence: R.shop.consequence(
      formatPoints(-offer.cost),
      service,
      formatClock(from + offer.minutes * 60_000),
    ),
    mnemonic: String(index + 1),
  };
}

function mascotView(snapshot: RecompensasInput['snapshot']): MascotView | null {
  const stage = mascotStageOf(snapshot);
  if (!stage) return null;
  const today = snapshot.state?.points.today ?? null;
  let text: string;
  if (stage === 'wilted') text = R.mascot.wilted(formatMinutes(MASCOT_RULES.recoveryFocusMinutes));
  else if (stage === 'tree') text = R.mascot.tree;
  else {
    const left = today ? minutesToGrow(stage, today) : null;
    text = left === null ? R.mascot.about : R.mascot.grow[stage](formatMinutes(left));
  }
  return { stage, name: R.mascot.names[stage], text };
}

function datumOf(allowances: readonly RewardAllowance[]): string | null {
  const [last] = allowances;
  if (!last) return null;
  if (allowances.length > 1) return R.openMany(formatInt(allowances.length));
  return R.open(serviceName(last.serviceId), formatClock(Date.parse(last.endsAt)));
}

export function deriveRecompensasView(input: RecompensasInput): RecompensasView {
  const { snapshot, rewards, redeemed, notice, nowMs } = input;
  const balance = balanceOf(input) ?? 0;
  const negative = balance < 0;
  // Closed: the shop's answer, else the last poll's (until the shop answered).
  const closed = rewards ? rewards.locked : (snapshot.state?.rewardsLock ?? null) !== null;
  const lockReason: RewardsLockReason | null = rewards
    ? rewards.locked
      ? rewards.lockReason
      : null
    : (snapshot.state?.rewardsLock ?? null);
  const lockText = closed ? (lockReason ? R.locked[lockReason] : R.closed) : null;
  const allowances = activeAllowances(input);

  // Which offers get a row: the ones the guardian could redeem now or refuses for a reason
  // that goes away (points, the 60 min cap); while closed, the ones a block covers.
  let offers: RewardOfferStatus[] = [];
  let hiddenServices: string[] = [];
  if (rewards) {
    if (rewards.locked) {
      const covered = coveredServices(snapshot.state);
      offers = rewards.offers.filter((o) => covered === 'all' || covered.has(o.serviceId));
    } else {
      offers = rewards.offers.filter((o) => o.unavailableReason !== 'not_blocked');
      const hidden = rewards.offers.filter((o) => o.unavailableReason === 'not_blocked');
      hiddenServices = [...new Set(hidden.map((o) => serviceName(o.serviceId)))];
    }
  }
  const rows = offers.map((offer, i) => offerRow(offer, i, balance, lockText, allowances, nowMs));

  let result: LineView | null = null;
  const opened = redeemed?.allowance ?? null;
  if (notice) result = notice;
  else if (redeemed && opened && Date.parse(opened.endsAt) > nowMs) {
    result = {
      tone: 'green',
      text: R.shop.redeemed(
        serviceName(opened.serviceId),
        formatClock(Date.parse(opened.endsAt)),
        formatPoints(redeemed.balanceAfter),
      ),
    };
  }

  let help: LineView;
  if (lockText) help = { tone: 'orange', text: lockText };
  else if (rows.some((r) => r.short) && rows.every((r) => r.disabledReason !== null)) {
    help = {
      tone: 'muted',
      text: R.shop.rowHelpShort(formatPoints(POINT_RULES.blockPointsPerMinute)),
    };
  } else help = { tone: 'muted', text: R.shop.rowHelp };

  return {
    title: lockText ? R.titleLocked : R.title(formatPoints(balance)),
    titleTone: negative && !lockText ? 'red' : 'default',
    pill: negative ? RENDERER.progreso.negative : null,
    datum: lockText ? formatPoints(balance) : datumOf(allowances),
    locked: lockText,
    rows,
    hidden:
      hiddenServices.length > 0
        ? R.shop.hidden(formatList(hiddenServices), hiddenServices.length)
        : null,
    empty: rewards !== null && !rewards.locked && rows.length === 0,
    help,
    result,
    mascot: mascotView(snapshot),
  };
}

/** The guardian's refusal of a redemption, in words (else the app-wide error copy). */
export function redeemErrorText(error: UiError, offer: RewardOfferStatus | null): string {
  const service = offer ? serviceName(offer.serviceId) : '';
  const details = error.details ?? {};
  switch (error.code) {
    case 'insufficient_points': {
      const shortBy = typeof details['shortBy'] === 'number' ? details['shortBy'] : null;
      return R.errors.short(formatPoints(Math.max(1, shortBy ?? offer?.shortBy ?? 1)));
    }
    case 'rewards_locked': {
      const reason = details['reason'];
      const known = REWARDS_LOCK_REASONS.find((r) => r === reason);
      return known ? R.locked[known] : R.closed;
    }
    case 'service_not_blocked':
      return R.errors.notBlocked(service);
    case 'allowance_limit_reached':
      return R.errors.limit(service, formatMinutes(GUARDIAN_LIMITS.allowanceMaxMinutes));
    case 'unknown_offer':
      return R.errors.unknownOffer;
    default:
      return errorCopy(error).text;
  }
}

/**
 * Why the shop could not be read: the guardian's state when it did not answer (stopped, not
 * installed, outdated…), else «No he podido leer la tienda».
 */
export function loadErrorText(error: UiError): string {
  switch (error.kind) {
    case 'rejected':
    case 'invalid_response':
    case 'internal':
      return R.errors.load;
    default:
      return errorCopy(error).text;
  }
}
