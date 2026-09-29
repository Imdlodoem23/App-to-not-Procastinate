/**
 * The coach's automatic, temporary kill switch (owner: COACH). docs/API.md §10.3.
 *
 * Failures that come from the owner's Anthropic account or settings, not from the request or a
 * passing outage (the credit or the Console's usage limit spent, a revoked key, a retired model
 * id or beta header), fail every call the same way until the owner acts. After
 * `BREAKER_STRIKES` of them in a row the breaker opens for `BREAKER_OPEN_MS`: /health reports
 * `coach: kill_switch`, every coach route answers 503 `feature_disabled` without calling the
 * model, and the app stops offering the coach instead of failing on every tap.
 *
 * - A strike is a failure the provider certainly did not bill (`billing: 'none'`) with reason
 *   `misconfigured` or `rejected`. `rejected` also covers a 400 caused by the request itself,
 *   so each user adds at most one `rejected` strike to a streak: one account cannot switch the
 *   coach off for everyone. `misconfigured` (401, 402, 403, 404) never depends on the request.
 * - Any answer, or a failure after the model ran, shows the account works: the streak ends.
 *   Unbilled `unavailable` failures (overload, 429, 5xx, network) neither add nor end it.
 * - When the window ends, one call is let through: one more strike opens it again at once.
 *
 * In process memory, one per `CoachModel` (so per app instance): a restart closes it, and the
 * next strikes open it again.
 */
import type { CoachModel, CoachModelError } from './model';

export const BREAKER_STRIKES = 3;
export const BREAKER_OPEN_MS = 15 * 60_000;

export class CoachBreaker {
  private strikes = 0;
  /** Users whose `rejected` strike is already in the streak. */
  private readonly rejectedBy = new Set<string>();
  private openUntilMs = 0;

  isOpen(now: Date): boolean {
    return now.getTime() < this.openUntilMs;
  }

  /** The model answered, or ran before failing: the account works. */
  succeeded(): void {
    this.strikes = 0;
    this.rejectedBy.clear();
  }

  /** Records a failed call; true when this failure opened the breaker. */
  failed(err: CoachModelError, userId: string, now: Date): boolean {
    if (err.billing !== 'none') {
      this.succeeded();
      return false;
    }
    if (err.reason === 'unavailable') return false;
    if (err.reason === 'rejected') {
      if (this.rejectedBy.has(userId)) return false;
      this.rejectedBy.add(userId);
    }
    this.strikes += 1;
    if (this.strikes < BREAKER_STRIKES) return false;
    this.openUntilMs = now.getTime() + BREAKER_OPEN_MS;
    // Half open once the window ends: the next strike, from anyone, opens it again.
    this.strikes = BREAKER_STRIKES - 1;
    this.rejectedBy.clear();
    return true;
  }
}

const breakers = new WeakMap<CoachModel, CoachBreaker>();

/** The breaker of `model` (created on first use). */
export function breakerOf(model: CoachModel): CoachBreaker {
  let breaker = breakers.get(model);
  if (!breaker) {
    breaker = new CoachBreaker();
    breakers.set(model, breaker);
  }
  return breaker;
}

/** True while the coach model's breaker is open (false without a model). */
export function isCoachBreakerOpen(model: CoachModel | null, now: Date): boolean {
  return model !== null && breakerOf(model).isOpen(now);
}
