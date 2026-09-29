import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { linkDownReason, linkOnFailure, linkOnSuccess } from '../../../src/main/guardian/link';
import { initialLink, uiError, type GuardianLink } from '../../../src/shared/ui-state';

describe('manual clock', () => {
  it('runs due timers in order, at their due time, including chained ones', () => {
    const clock = createManualClock(1_000);
    const seen: Array<[string, number]> = [];
    clock.setTimeout(() => seen.push(['b', clock.now()]), 200);
    clock.setTimeout(() => {
      seen.push(['a', clock.now()]);
      clock.setTimeout(() => seen.push(['c', clock.now()]), 50);
    }, 100);
    const cancelled = clock.setTimeout(() => seen.push(['x', clock.now()]), 120);
    clock.clearTimeout(cancelled);
    clock.advance(500);
    expect(seen).toEqual([
      ['a', 1_100],
      ['c', 1_150],
      ['b', 1_200],
    ]);
    expect(clock.now()).toBe(1_500);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('keeps timers beyond the advanced window', () => {
    const clock = createManualClock(0);
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 1_000);
    clock.advance(999);
    expect(fired).toBe(false);
    expect(clock.nextDueAt()).toBe(1_000);
    clock.advance(1);
    expect(fired).toBe(true);
  });
});

describe('guardian link rule', () => {
  const ok: GuardianLink = { status: 'ok', reason: null, since: 0, lastOkAt: 0, failures: 0 };

  it('needs two consecutive refused connections before going down (no flapping)', () => {
    const first = linkOnFailure(ok, 0, uiError('unreachable'), 1_000);
    expect(first.link).toBe(ok);
    expect(first.retry).toBe(true);
    const recovered = linkOnSuccess(first.link, 2_000);
    expect(recovered.link).toBe(ok);
    const second = linkOnFailure(ok, first.failures, uiError('unreachable'), 2_000);
    expect(second.link.status).toBe('down');
    expect(second.link.reason).toBe('unreachable');
    expect(second.retry).toBe(false);
  });

  it('goes down at once for timeouts, a missing client.json, 401 and incompatible APIs', () => {
    for (const [kind, reason] of [
      ['timeout', 'timeout'],
      ['not_installed', 'not_installed'],
      ['unauthorized', 'unauthorized'],
      ['incompatible', 'incompatible'],
      ['invalid_response', 'incompatible'],
    ] as const) {
      const step = linkOnFailure(ok, 0, uiError(kind), 5);
      expect(step.link.status).toBe('down');
      expect(step.link.reason).toBe(reason);
    }
  });

  it('publishes nothing while the state does not change', () => {
    const down = linkOnFailure(ok, 1, uiError('unreachable'), 5).link;
    expect(linkOnFailure(down, 2, uiError('unreachable'), 6).link).toBe(down);
    expect(linkOnSuccess(ok, 7).link).toBe(ok);
    const up = linkOnSuccess(down, 8).link;
    expect(up).toMatchObject({ status: 'ok', failures: 0, lastOkAt: 8 });
    expect(linkOnSuccess(initialLink(0), 3).link.status).toBe('ok');
  });

  it('maps other failures to «detenido»', () => {
    expect(linkDownReason(uiError('internal'))).toBe('unreachable');
    expect(linkDownReason(uiError('rejected', 'rate_limited', 429))).toBe('unreachable');
  });
});
