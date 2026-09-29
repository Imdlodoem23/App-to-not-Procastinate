import { describe, expect, it } from 'vitest';
import { ShowAckWaiter, decideToggle } from '../../../src/main/windows/toggle';

describe('tray toggle', () => {
  it('shows a hidden window', () => {
    expect(decideToggle({ visible: false, focused: false, lastBlurAt: null, now: 1000 })).toBe(
      'show',
    );
  });

  it('hides a focused window', () => {
    expect(decideToggle({ visible: true, focused: true, lastBlurAt: null, now: 1000 })).toBe(
      'hide',
    );
  });

  it('hides a window that lost focus to the tray click itself (< 250 ms ago)', () => {
    expect(decideToggle({ visible: true, focused: false, lastBlurAt: 900, now: 1000 })).toBe(
      'hide',
    );
    expect(decideToggle({ visible: true, focused: false, lastBlurAt: 751, now: 1000 })).toBe(
      'hide',
    );
  });

  it('brings a covered window to the front', () => {
    expect(decideToggle({ visible: true, focused: false, lastBlurAt: 700, now: 1000 })).toBe(
      'raise',
    );
    expect(decideToggle({ visible: true, focused: false, lastBlurAt: null, now: 1000 })).toBe(
      'raise',
    );
  });
});

describe('ShowAckWaiter', () => {
  function fakeTimers() {
    const timers = new Map<number, () => void>();
    let next = 1;
    return {
      timers,
      api: {
        setTimeout: (fn: () => void) => {
          const id = next++;
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (id: unknown) => {
          timers.delete(id as number);
        },
      },
      fire() {
        for (const [id, fn] of [...timers]) {
          timers.delete(id);
          fn();
        }
      },
    };
  }

  it('resolves with the matching ack', async () => {
    const t = fakeTimers();
    const waiter = new ShowAckWaiter<string>(t.api);
    const seq = waiter.next();
    const result = waiter.wait(seq, 50);
    expect(waiter.ack(seq + 1, 'stale')).toBe(false);
    expect(waiter.ack(seq, 'ok')).toBe(true);
    await expect(result).resolves.toBe('ok');
    expect(t.timers.size).toBe(0);
  });

  it('resolves null on timeout, and a late ack is refused', async () => {
    const t = fakeTimers();
    const waiter = new ShowAckWaiter<string>(t.api);
    const seq = waiter.next();
    const result = waiter.wait(seq, 50);
    t.fire();
    await expect(result).resolves.toBeNull();
    expect(waiter.ack(seq, 'late')).toBe(false);
  });

  it('a newer wait supersedes an older one', async () => {
    const t = fakeTimers();
    const waiter = new ShowAckWaiter<string>(t.api);
    const first = waiter.wait(waiter.next(), 50);
    const seq2 = waiter.next();
    const second = waiter.wait(seq2, 50);
    await expect(first).resolves.toBeNull();
    waiter.ack(seq2, 'two');
    await expect(second).resolves.toBe('two');
  });
});
