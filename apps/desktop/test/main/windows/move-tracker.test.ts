import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/shared/fixtures';
import { MoveTracker, WM_ADJUST_GRACE_MS } from '../../../src/main/windows/move-tracker';

const CORNER: Rect = { x: 1470, y: 673, width: 440, height: 348 };
const at = (x: number, y: number, height = 348): Rect => ({ x, y, width: 440, height });

function placedAtCorner(now = 0): MoveTracker {
  const tracker = new MoveTracker();
  tracker.placed(CORNER, CORNER, now);
  tracker.clearMoved();
  return tracker;
}

describe('MoveTracker', () => {
  it('sees nothing before the first placement', () => {
    const tracker = new MoveTracker();
    expect(tracker.observe(at(300, 200), 10_000)).toBe(false);
    expect(tracker.intended()).toBeNull();
    expect(tracker.userMoved()).toBe(false);
  });

  it('ignores its own placements and 1 DIP of readback rounding', () => {
    const tracker = placedAtCorner();
    // Linux: `move` once more when the X server confirms the same position.
    expect(tracker.observe(CORNER, 5_000)).toBe(false);
    expect(tracker.observe(at(1471, 672), 5_000)).toBe(false);
    // A resize from the anchored edge moves the origin, but we placed it there.
    const grown = at(1470, 561, 460);
    tracker.placed(grown, grown, 6_000);
    expect(tracker.observe(grown, 6_010)).toBe(false);
    expect(tracker.userMoved()).toBe(false);
    expect(tracker.intended()).toEqual(grown);
  });

  it('detects a Linux drag from positions alone (only `move` fires there)', () => {
    const tracker = placedAtCorner();
    // The reported case: moved to (300, 200), then a phrase + Enter grows the window.
    expect(tracker.observe(at(300, 200), 2_000)).toBe(true);
    expect(tracker.userMoved()).toBe(true);
    // The next resize starts from where the user put it, not from the corner.
    expect(tracker.intended()).toEqual(at(300, 200));
    // Further drag steps are moves too; staying put is not.
    expect(tracker.observe(at(320, 210), 2_050)).toBe(true);
    expect(tracker.observe(at(320, 210), 2_100)).toBe(false);
    expect(tracker.intended()).toEqual(at(320, 210));
  });

  it('keeps the rect it asked for when the window manager adjusts it right after', () => {
    const tracker = placedAtCorner(1_000);
    // Within the grace period: decorations / constraints, not the user.
    expect(tracker.observe(at(1470, 710), 1_000 + WM_ADJUST_GRACE_MS - 1)).toBe(false);
    expect(tracker.userMoved()).toBe(false);
    expect(tracker.intended()).toEqual(CORNER);
    // The adjusted position is the new reference: seeing it again later is no move…
    expect(tracker.observe(at(1470, 710), 9_000)).toBe(false);
    // …leaving it is.
    expect(tracker.observe(at(900, 710), 9_000)).toBe(true);
  });

  it('adopts a Windows/macOS drag between will-move and moved, even right after a placement', () => {
    const tracker = placedAtCorner(1_000);
    tracker.userMoving();
    expect(tracker.userMoved()).toBe(true);
    expect(tracker.observe(at(1200, 600), 1_050)).toBe(true);
    expect(tracker.dragEnded(at(1100, 500), 1_100)).toBe(true);
    expect(tracker.intended()).toEqual(at(1100, 500));
  });

  it('treats `moved` for its own placement (macOS alias of `move`) as no move', () => {
    const tracker = placedAtCorner(1_000);
    expect(tracker.dragEnded(CORNER, 1_010)).toBe(false);
    expect(tracker.userMoved()).toBe(false);
  });

  it('forgets on hide or recreate, and clears the move back at the corner', () => {
    const tracker = placedAtCorner();
    tracker.observe(at(300, 200), 5_000);
    expect(tracker.userMoved()).toBe(true);
    tracker.forget();
    expect(tracker.intended()).toBeNull();
    expect(tracker.observe(at(10, 10), 6_000)).toBe(false);
    tracker.placed(CORNER, CORNER, 7_000);
    tracker.clearMoved();
    expect(tracker.userMoved()).toBe(false);
  });

  it('returns copies', () => {
    const tracker = placedAtCorner();
    const rect = tracker.intended();
    if (rect) rect.x = 0;
    expect(tracker.intended()).toEqual(CORNER);
  });
});
