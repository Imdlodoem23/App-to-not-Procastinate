/**
 * Whether the user moved the main window away from where the shell put it (docs/DESKTOP.md
 * §8.3). Pure: positions and times are passed in.
 *
 * `will-move` and `moved` exist only on Windows and macOS. On Linux the only signal is `move`,
 * which also fires for our own `setContentBounds` (synchronously, then once more when the X
 * server confirms). So a move is detected by position instead: the window's origin is more
 * than 1 DIP away from where it was seen right after our last placement. A difference that
 * shows up within `graceMs` of that placement is the window manager adjusting it
 * (decorations, constraints): it becomes the new reference, and the next resize still starts
 * from the rect we asked for, so a window manager offset never accumulates.
 */
import { movedAway, MOVE_TOLERANCE, type Rect } from './geometry';

/** How long after our own placement a position change is the window manager's doing. */
export const WM_ADJUST_GRACE_MS = 300;

export interface MoveTrackerOptions {
  graceMs?: number;
  tolerance?: number;
}

export class MoveTracker {
  private readonly graceMs: number;
  private readonly tolerance: number;
  private intendedRect: Rect | null = null;
  private seen: Rect | null = null;
  private placedAt = Number.NEGATIVE_INFINITY;
  private moved = false;
  /** Between `will-move` and `moved` (Windows, macOS): every change is the user's. */
  private dragging = false;

  constructor(options: MoveTrackerOptions = {}) {
    this.graceMs = options.graceMs ?? WM_ADJUST_GRACE_MS;
    this.tolerance = options.tolerance ?? MOVE_TOLERANCE;
  }

  /**
   * Where the window is meant to be: the rect we last set, or where the user put it. `null`
   * before any placement (and after `forget`).
   */
  intended(): Rect | null {
    return this.intendedRect ? { ...this.intendedRect } : null;
  }

  /** The user moved it since it was last placed at its corner. */
  userMoved(): boolean {
    return this.moved;
  }

  /** We set the window to `intended`; `seen` is what it reports right after. */
  placed(intended: Rect, seen: Rect, now: number): void {
    this.intendedRect = { ...intended };
    this.seen = { ...seen };
    this.placedAt = now;
  }

  /**
   * A position reading (`move` event, or before a resize). Returns `true` when it reveals a
   * user move: the window is then meant to stay where it is (`intended()` becomes `actual`).
   */
  observe(actual: Rect, now: number): boolean {
    if (!this.seen) return false;
    if (!movedAway(actual, this.seen, this.tolerance)) return false;
    if (!this.dragging && now - this.placedAt <= this.graceMs) {
      this.seen = { ...actual };
      return false;
    }
    this.keep(actual);
    return true;
  }

  /** The platform says the user is moving it (`will-move`, Windows and macOS). */
  userMoving(): void {
    this.moved = true;
    this.dragging = true;
  }

  /**
   * `moved` (Windows, macOS; on macOS an alias of `move`, so possibly our own placement): the
   * drag ended at `actual`. Returns `true` when that is a user move.
   */
  dragEnded(actual: Rect, now: number): boolean {
    const moved = this.observe(actual, now);
    this.dragging = false;
    return moved;
  }

  /** Placed back at its corner (the show path). */
  clearMoved(): void {
    this.moved = false;
    this.dragging = false;
  }

  private keep(actual: Rect): void {
    this.moved = true;
    this.intendedRect = { ...actual };
    this.seen = { ...actual };
  }

  /** Hidden or recreated: the next placement starts from nothing. */
  forget(): void {
    this.intendedRect = null;
    this.seen = null;
    this.placedAt = Number.NEGATIVE_INFINITY;
  }
}
