/**
 * The reward shop of the in-memory guardian (ARCHITECTURE §5.7, §10.7): which offers are
 * available for a balance, the active blocks and allowances, and the redemption checks in the
 * guardian's order (unknown offer, locked, service not blocked, insufficient points, allowance
 * limit). Pure.
 */
import { getService } from '@centrate/shared/catalog';
import type { Block, RewardAllowance, RewardsLockReason } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  type GuardianErrorCode,
  type RewardOfferStatus,
  type RewardsResponse,
} from '@centrate/shared/guardian-api';
import { REWARD_OFFERS, findRewardOffer, type RewardOffer } from '@centrate/shared/points';

/** Whether a non-whitelist active block covers the service (directly or by category). */
export function serviceCoveredByBlocks(blocks: readonly Block[], serviceId: string): boolean {
  const service = getService(serviceId);
  if (!service) return false;
  return blocks.some(
    (b) =>
      !b.whitelistOnly &&
      (b.targets.serviceIds.includes(serviceId) ||
        b.targets.categoryIds.some((c) => service.categories.includes(c))),
  );
}

export interface ShopInput {
  balance: number;
  blocks: readonly Block[];
  allowances: readonly RewardAllowance[];
  lock: RewardsLockReason | null;
}

function activeAllowance(
  allowances: readonly RewardAllowance[],
  serviceId: string,
): RewardAllowance | null {
  return allowances.find((a) => a.serviceId === serviceId && a.status === 'active') ?? null;
}

function offerStatus(offer: RewardOffer, input: ShopInput): RewardOfferStatus {
  const affordable = input.balance >= offer.cost;
  const current = activeAllowance(input.allowances, offer.serviceId);
  const overLimit =
    current !== null && current.minutes + offer.minutes > GUARDIAN_LIMITS.allowanceMaxMinutes;
  const unavailableReason: RewardOfferStatus['unavailableReason'] =
    input.lock !== null
      ? 'locked'
      : !serviceCoveredByBlocks(input.blocks, offer.serviceId)
        ? 'not_blocked'
        : !affordable
          ? 'insufficient_points'
          : overLimit
            ? 'allowance_limit'
            : null;
  return {
    offerId: offer.id,
    serviceId: offer.serviceId,
    minutes: offer.minutes,
    cost: offer.cost,
    affordable,
    shortBy: affordable ? 0 : offer.cost - input.balance,
    available: unavailableReason === null,
    unavailableReason,
  };
}

export function rewardsShop(input: ShopInput): RewardsResponse {
  return {
    locked: input.lock !== null,
    lockReason: input.lock,
    balance: input.balance,
    offers: REWARD_OFFERS.map((o) => offerStatus(o, input)),
    allowances: input.allowances.filter((a) => a.status === 'active').map((a) => ({ ...a })),
  };
}

export type RedeemCheck =
  | { ok: true; offer: RewardOffer; extend: RewardAllowance | null }
  | { ok: false; code: GuardianErrorCode; details: Record<string, unknown> | null };

/** The guardian's redemption checks, in its order. */
export function checkRedeem(offerId: string, input: ShopInput): RedeemCheck {
  const offer = findRewardOffer(offerId);
  if (!offer) return { ok: false, code: 'unknown_offer', details: null };
  if (input.lock !== null) return { ok: false, code: 'rewards_locked', details: { reason: input.lock } };
  if (!serviceCoveredByBlocks(input.blocks, offer.serviceId)) {
    return { ok: false, code: 'service_not_blocked', details: null };
  }
  if (input.balance < offer.cost) {
    return {
      ok: false,
      code: 'insufficient_points',
      details: { balance: input.balance, cost: offer.cost, shortBy: offer.cost - input.balance },
    };
  }
  const current = activeAllowance(input.allowances, offer.serviceId);
  if (current && current.minutes + offer.minutes > GUARDIAN_LIMITS.allowanceMaxMinutes) {
    return {
      ok: false,
      code: 'allowance_limit_reached',
      details: { maxMinutes: GUARDIAN_LIMITS.allowanceMaxMinutes, currentMinutes: current.minutes },
    };
  }
  return { ok: true, offer, extend: current };
}
