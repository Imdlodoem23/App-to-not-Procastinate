import { describe, expect, it } from 'vitest';
import {
  DISPLAY_PRESETS,
  DISPLAY_PRESET_IDS,
  layoutForDisplay,
  type FrameInsets,
  type Rect,
} from '../../../src/shared/fixtures';
import {
  DETAIL_CONTENT_WIDTH,
  MAIN_CONTENT_WIDTH,
  SCREEN_INSET,
  ZERO_FRAME,
  anchorFor,
  centredContentRect,
  chooseDisplay,
  clampContentHeight,
  contentFromOuter,
  detailPlacement,
  displayMatching,
  displayNearestPoint,
  frameInsets,
  isOnPixelGrid,
  mainContentRect,
  maxContentHeight,
  movedAway,
  needsSizeReapply,
  outerFromContent,
  pixelGrid,
  pixelSnapSlack,
  rectBottom,
  rectRight,
  resizeAnchored,
  snapToPixelGrid,
  windowLayout,
  type DisplayInfo,
  type PixelGrid,
} from '../../../src/main/windows/geometry';

const WIN_FRAME: FrameInsets = { top: 32, right: 1, bottom: 1, left: 1 };

function display(id: number, bounds: Rect, workArea: Rect = bounds, scaleFactor = 1): DisplayInfo {
  return { id, bounds, workArea, scaleFactor };
}

/** 1920×1080 with a 48 DIP taskbar at the bottom. */
const BOTTOM_BAR = display(
  1,
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 0, width: 1920, height: 1032 },
);
/** macOS: 25 DIP menu bar on top. */
const MAC = display(
  2,
  { x: 0, y: 0, width: 1512, height: 982 },
  { x: 0, y: 25, width: 1512, height: 957 },
);
/** Ubuntu: 32 DIP top panel. */
const UBUNTU = display(
  3,
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 32, width: 1920, height: 1048 },
);
/** KDE: 44 DIP bottom panel. */
const KDE = display(
  4,
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 0, width: 1920, height: 1036 },
);

describe('display choice', () => {
  // A primary display and a second one to its left and above (negative coordinates).
  const primary = display(
    10,
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  const left = display(
    11,
    { x: -1280, y: -200, width: 1280, height: 1024 },
    { x: -1280, y: -200, width: 1280, height: 984 },
  );

  it('finds the display under a point, or the nearest one', () => {
    expect(displayNearestPoint([primary, left], { x: -10, y: 100 }).id).toBe(11);
    expect(displayNearestPoint([primary, left], { x: 100, y: 100 }).id).toBe(10);
    // Off every display: the nearest (left of the left one).
    expect(displayNearestPoint([primary, left], { x: -5000, y: 0 }).id).toBe(11);
    expect(displayNearestPoint([primary, left], { x: 5000, y: 500 }).id).toBe(10);
  });

  it('matches a rect to the display it overlaps most', () => {
    expect(displayMatching([primary, left], { x: -100, y: 700, width: 24, height: 24 }).id).toBe(
      11,
    );
    // Overlaps neither: the display nearest its centre.
    expect(displayMatching([primary, left], { x: -100, y: 1000, width: 24, height: 24 }).id).toBe(
      10,
    );
    expect(displayMatching([primary, left], { x: -10, y: 50, width: 40, height: 40 }).id).toBe(10);
  });

  it('uses the tray display on Windows and macOS, the cursor display on Linux', () => {
    const trayOnLeft: Rect = { x: -300, y: 740, width: 24, height: 24 };
    const cursorOnPrimary = { x: 500, y: 500 };
    expect(chooseDisplay('win32', [primary, left], trayOnLeft, cursorOnPrimary).id).toBe(11);
    expect(chooseDisplay('darwin', [primary, left], trayOnLeft, cursorOnPrimary).id).toBe(11);
    expect(chooseDisplay('linux', [primary, left], trayOnLeft, cursorOnPrimary).id).toBe(10);
  });

  it('falls back to the cursor display when the tray reports zero bounds', () => {
    const zero: Rect = { x: 0, y: 0, width: 0, height: 0 };
    expect(chooseDisplay('win32', [primary, left], zero, { x: -600, y: 0 }).id).toBe(11);
    expect(chooseDisplay('win32', [primary, left], null, { x: 600, y: 0 }).id).toBe(10);
  });
});

describe('anchor', () => {
  it('is bottom on Windows whatever the taskbar edge, top on macOS', () => {
    const topTaskbar = display(5, BOTTOM_BAR.bounds, { x: 0, y: 48, width: 1920, height: 1032 });
    expect(anchorFor('win32', BOTTOM_BAR)).toBe('bottom');
    expect(anchorFor('win32', topTaskbar)).toBe('bottom');
    expect(anchorFor('darwin', MAC)).toBe('top');
  });

  it('follows the panel side on Linux (top when there is no panel)', () => {
    expect(anchorFor('linux', UBUNTU)).toBe('top');
    expect(anchorFor('linux', KDE)).toBe('bottom');
    expect(anchorFor('linux', display(6, BOTTOM_BAR.bounds))).toBe('top');
  });
});

describe('height budget', () => {
  it('is the work area minus 2 × 10 and the frame', () => {
    expect(maxContentHeight(BOTTOM_BAR.workArea, WIN_FRAME)).toBe(1032 - 20 - 33);
    expect(maxContentHeight(MAC.workArea, ZERO_FRAME)).toBe(957 - 20);
  });

  it('matches fixtures.layoutForDisplay on every preset', () => {
    for (const id of DISPLAY_PRESET_IDS) {
      const preset = DISPLAY_PRESETS[id];
      const info = display(1, preset.bounds, preset.workArea, preset.scaleFactor);
      expect(windowLayout(preset.platform, info, preset.frame), id).toEqual(
        layoutForDisplay(preset),
      );
    }
  });

  it('clamps a reported height to whole DIP within the budget', () => {
    expect(clampContentHeight(412.3, 979)).toBe(413);
    expect(clampContentHeight(2000, 979)).toBe(979);
    expect(clampContentHeight(Number.NaN, 500)).toBe(500);
    expect(clampContentHeight(0, 500)).toBe(1);
  });
});

describe('main window placement', () => {
  it('sits 10 DIP from the bottom-right corner on Windows', () => {
    const rect = mainContentRect({
      workArea: BOTTOM_BAR.workArea,
      frame: WIN_FRAME,
      anchor: 'bottom',
      height: 500,
    });
    const outer = outerFromContent(rect, WIN_FRAME);
    expect(rect.width).toBe(MAIN_CONTENT_WIDTH);
    expect(rect.height).toBe(500);
    expect(rectRight(BOTTOM_BAR.workArea) - rectRight(outer)).toBe(SCREEN_INSET);
    expect(rectBottom(BOTTOM_BAR.workArea) - rectBottom(outer)).toBe(SCREEN_INSET);
  });

  it('sits 10 DIP from the top-right corner on macOS', () => {
    const rect = mainContentRect({
      workArea: MAC.workArea,
      frame: { top: 28, right: 0, bottom: 0, left: 0 },
      anchor: 'top',
      height: 500,
    });
    const outer = outerFromContent(rect, { top: 28, right: 0, bottom: 0, left: 0 });
    expect(outer.y - MAC.workArea.y).toBe(SCREEN_INSET);
    expect(rectRight(MAC.workArea) - rectRight(outer)).toBe(SCREEN_INSET);
  });

  it('uses the panel-side right corner on Linux', () => {
    const top = mainContentRect({
      workArea: UBUNTU.workArea,
      frame: ZERO_FRAME,
      anchor: anchorFor('linux', UBUNTU),
      height: 400,
    });
    expect(top.y).toBe(32 + SCREEN_INSET);
    const bottom = mainContentRect({
      workArea: KDE.workArea,
      frame: ZERO_FRAME,
      anchor: anchorFor('linux', KDE),
      height: 400,
    });
    expect(rectBottom(bottom)).toBe(1036 - SCREEN_INSET);
    expect(rectRight(bottom)).toBe(1920 - SCREEN_INSET);
  });

  it('works on a display with negative coordinates', () => {
    const wa: Rect = { x: -1280, y: -200, width: 1280, height: 984 };
    const rect = mainContentRect({ workArea: wa, frame: WIN_FRAME, anchor: 'bottom', height: 300 });
    const outer = outerFromContent(rect, WIN_FRAME);
    expect(rectRight(outer)).toBe(-SCREEN_INSET);
    expect(rectBottom(outer)).toBe(784 - SCREEN_INSET);
  });

  it('never grows past the work area', () => {
    const rect = mainContentRect({
      workArea: BOTTOM_BAR.workArea,
      frame: WIN_FRAME,
      anchor: 'bottom',
      height: 5000,
    });
    const outer = outerFromContent(rect, WIN_FRAME);
    expect(outer.y).toBe(SCREEN_INSET);
    expect(rectBottom(outer)).toBe(1032 - SCREEN_INSET);
  });

  it('rounds to whole DIP at 125 % and 150 %', () => {
    for (const id of ['1366x768@125', '1920x1080@150'] as const) {
      const preset = DISPLAY_PRESETS[id];
      const rect = mainContentRect({
        workArea: preset.workArea,
        frame: preset.frame,
        anchor: 'bottom',
        height: 431.6,
      });
      for (const v of [rect.x, rect.y, rect.width, rect.height])
        expect(Number.isInteger(v)).toBe(true);
      const outer = outerFromContent(rect, preset.frame);
      expect(rectBottom(preset.workArea) - rectBottom(outer)).toBe(SCREEN_INSET);
    }
  });
});

describe('anchored resize', () => {
  const wa = BOTTOM_BAR.workArea;
  const start = mainContentRect({ workArea: wa, frame: WIN_FRAME, anchor: 'bottom', height: 400 });

  it('keeps the bottom edge when growing and shrinking (Windows)', () => {
    const grown = resizeAnchored(start, 560, 'bottom', wa, WIN_FRAME);
    const shrunk = resizeAnchored(grown, 300, 'bottom', wa, WIN_FRAME);
    expect(rectBottom(grown)).toBe(rectBottom(start));
    expect(rectBottom(shrunk)).toBe(rectBottom(start));
    expect(grown.height).toBe(560);
    expect(shrunk.height).toBe(300);
    expect(grown.x).toBe(start.x);
  });

  it('keeps the top edge (macOS)', () => {
    const top = mainContentRect({
      workArea: MAC.workArea,
      frame: ZERO_FRAME,
      anchor: 'top',
      height: 400,
    });
    const grown = resizeAnchored(top, 600, 'top', MAC.workArea, ZERO_FRAME);
    expect(grown.y).toBe(top.y);
    expect(grown.height).toBe(600);
  });

  it('stays inside the work area when the height hits the budget', () => {
    const huge = resizeAnchored(start, 5000, 'bottom', wa, WIN_FRAME);
    expect(huge.height).toBe(maxContentHeight(wa, WIN_FRAME));
    expect(huge.y).toBeGreaterThanOrEqual(wa.y + WIN_FRAME.top);
  });

  it('is stable: resizing to the same height changes nothing (no 1 DIP drift)', () => {
    let rect = start;
    for (let i = 0; i < 20; i += 1) rect = resizeAnchored(rect, 400.4, 'bottom', wa, WIN_FRAME);
    expect(rect).toEqual(resizeAnchored(start, 401, 'bottom', wa, WIN_FRAME));
  });
});

describe('detail window placement', () => {
  const wa = BOTTOM_BAR.workArea;

  function mainOuterAt(height: number): Rect {
    return outerFromContent(
      mainContentRect({ workArea: wa, frame: WIN_FRAME, anchor: 'bottom', height }),
      WIN_FRAME,
    );
  }

  it('is glued to the left of the main window with a 6 DIP gap, bottom-aligned', () => {
    const mainOuter = mainOuterAt(520);
    const p = detailPlacement({ mainOuter, workArea: wa, anchor: 'bottom', frame: WIN_FRAME });
    expect(p.side).toBe('left');
    expect(mainOuter.x - rectRight(p.outer)).toBe(6);
    expect(rectBottom(p.outer)).toBe(rectBottom(mainOuter));
    expect(p.outer.height).toBe(mainOuter.height);
    expect(p.content.width).toBe(DETAIL_CONTENT_WIDTH);
  });

  it('is at least 480 DIP of content even next to a short main window', () => {
    const p = detailPlacement({
      mainOuter: mainOuterAt(300),
      workArea: wa,
      anchor: 'bottom',
      frame: WIN_FRAME,
    });
    expect(p.content.height).toBe(480);
    expect(rectBottom(p.outer)).toBe(rectBottom(mainOuterAt(300)));
  });

  it('is top-aligned on macOS', () => {
    const frame = { top: 28, right: 0, bottom: 0, left: 0 };
    const mainOuter = outerFromContent(
      mainContentRect({ workArea: MAC.workArea, frame, anchor: 'top', height: 500 }),
      frame,
    );
    const p = detailPlacement({ mainOuter, workArea: MAC.workArea, anchor: 'top', frame });
    expect(p.outer.y).toBe(mainOuter.y);
  });

  it('goes to the right when there is no room on the left', () => {
    const narrow: Rect = { x: 0, y: 0, width: 1700, height: 1032 };
    const mainOuter: Rect = { x: 100, y: 400, width: 442, height: 600 };
    const p = detailPlacement({ mainOuter, workArea: narrow, anchor: 'bottom', frame: WIN_FRAME });
    expect(p.side).toBe('right');
    expect(p.outer.x).toBe(rectRight(mainOuter) + 6);
  });

  it('is pinned to the work area when it fits on neither side', () => {
    const small: Rect = { x: 0, y: 0, width: 1000, height: 700 };
    const mainOuter = outerFromContent(
      mainContentRect({ workArea: small, frame: WIN_FRAME, anchor: 'bottom', height: 500 }),
      WIN_FRAME,
    );
    const p = detailPlacement({ mainOuter, workArea: small, anchor: 'bottom', frame: WIN_FRAME });
    expect(p.side).toBe('pinned');
    expect(p.outer.x).toBe(0);
  });

  it('is clamped to the work area height', () => {
    const short: Rect = { x: 0, y: 0, width: 1920, height: 400 };
    const mainOuter = outerFromContent(
      mainContentRect({ workArea: short, frame: WIN_FRAME, anchor: 'bottom', height: 2000 }),
      WIN_FRAME,
    );
    const p = detailPlacement({ mainOuter, workArea: short, anchor: 'bottom', frame: WIN_FRAME });
    expect(p.outer.height).toBe(400 - 2 * SCREEN_INSET);
    expect(p.outer.y).toBeGreaterThanOrEqual(0);
    expect(rectBottom(p.outer)).toBeLessThanOrEqual(400);
  });
});

describe('frame helpers', () => {
  it('measures insets and converts both ways', () => {
    const outer: Rect = { x: 100, y: 100, width: 442, height: 573 };
    const content: Rect = { x: 101, y: 132, width: 440, height: 540 };
    const frame = frameInsets(outer, content);
    expect(frame).toEqual(WIN_FRAME);
    expect(outerFromContent(content, frame)).toEqual(outer);
    expect(contentFromOuter(outer, frame)).toEqual(content);
  });
});

describe('device-pixel grid', () => {
  const grid125: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1.25 };
  const grid150: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1.5 };

  it('knows pixel edges and how far an inset may grow', () => {
    expect(isOnPixelGrid(640, 0, 1.25)).toBe(true);
    expect(isOnPixelGrid(642, 0, 1.25)).toBe(false);
    expect(isOnPixelGrid(829, 0, 1.5)).toBe(false);
    expect(isOnPixelGrid(828, 0, 1.5)).toBe(true);
    // Relative to the display's origin (a display at x = −1093 at 125 %).
    expect(isOnPixelGrid(-453, -1093, 1.25)).toBe(true);
    expect(pixelSnapSlack(1)).toBe(0);
    expect(pixelSnapSlack(2)).toBe(0);
    expect(pixelSnapSlack(1.25)).toBe(3);
    expect(pixelSnapSlack(1.5)).toBe(1);
    expect(pixelSnapSlack(1.75)).toBe(3);
    expect(pixelSnapSlack(1.1)).toBe(0);
  });

  it('moves 0–3 DIP the preferred way, the other way only when a limit forbids it', () => {
    expect(snapToPixelGrid(642, 0, grid125, -1)).toBe(640);
    expect(snapToPixelGrid(642, 0, grid125, 1)).toBe(644);
    expect(snapToPixelGrid(640, 0, grid125, -1)).toBe(640);
    expect(snapToPixelGrid(829, 0, grid150, -1)).toBe(828);
    expect(snapToPixelGrid(642, 0, grid125, -1, { min: 641 })).toBe(644);
    // Nothing within reach inside the limits: rounded and clamped, not snapped.
    expect(snapToPixelGrid(641.6, 0, grid125, -1, { min: 641, max: 643 })).toBe(642);
    // No grid, or an integer scale: whole DIP only.
    expect(snapToPixelGrid(641.6, 0, null, -1)).toBe(642);
    expect(snapToPixelGrid(641, 0, { origin: { x: 0, y: 0 }, scaleFactor: 2 }, -1)).toBe(641);
    // 110 %: pixel edges every 10 DIP, so usually none within 3.
    expect(snapToPixelGrid(645, 0, { origin: { x: 0, y: 0 }, scaleFactor: 1.1 }, -1)).toBe(645);
  });

  const HEIGHTS = [300, 348, 349, 350, 351, 431, 460, 513, 540, 5000];

  for (const id of DISPLAY_PRESET_IDS) {
    it(`keeps windows whole-pixel on ${id}`, () => {
      const preset = DISPLAY_PRESETS[id];
      const info = display(1, preset.bounds, preset.workArea, preset.scaleFactor);
      const grid = pixelGrid(info);
      const s = preset.scaleFactor;
      const slack = pixelSnapSlack(s);
      const wa = preset.workArea;
      const onGridX = (v: number): boolean => isOnPixelGrid(v, grid.origin.x, s);
      const onGridY = (v: number): boolean => isOnPixelGrid(v, grid.origin.y, s);
      for (const height of HEIGHTS) {
        const where = `${id}, height ${height}`;
        const rect = mainContentRect({
          workArea: wa,
          frame: preset.frame,
          anchor: 'bottom',
          height,
          grid,
        });
        const outer = outerFromContent(rect, preset.frame);
        expect(rect.width, where).toBe(MAIN_CONTENT_WIDTH);
        expect(onGridX(rect.x) && onGridX(rectRight(rect)), `${where}: x edges`).toBe(true);
        expect(onGridY(rectBottom(rect)), `${where}: anchored bottom edge`).toBe(true);
        const right = rectRight(wa) - rectRight(outer);
        const bottom = rectBottom(wa) - rectBottom(outer);
        expect(right, `${where}: right inset`).toBeGreaterThanOrEqual(SCREEN_INSET);
        expect(right, `${where}: right inset`).toBeLessThanOrEqual(SCREEN_INSET + slack);
        expect(bottom, `${where}: bottom inset`).toBeGreaterThanOrEqual(SCREEN_INSET);
        expect(bottom, `${where}: bottom inset`).toBeLessThanOrEqual(SCREEN_INSET + slack);
        expect(outer.y, `${where}: top edge`).toBeGreaterThanOrEqual(wa.y + SCREEN_INSET - slack);
        // The free (top) edge grows 0–slack DIP onto the grid, so the height is whole pixels,
        // unless that would cross the work area's inset line.
        const asked = Math.min(height, maxContentHeight(wa, preset.frame));
        expect(rect.height, `${where}: height`).toBeGreaterThanOrEqual(asked);
        expect(rect.height, `${where}: height`).toBeLessThanOrEqual(asked + slack);
        if (rectBottom(rect) - asked - slack >= wa.y + SCREEN_INSET + preset.frame.top) {
          expect(onGridY(rect.y), `${where}: free top edge`).toBe(true);
        }

        // Resizing from there keeps the anchored edge, the width and the grid.
        const grown = resizeAnchored(rect, height + 113, 'bottom', wa, preset.frame, grid);
        expect(rectBottom(grown), `${where}: resize keeps the bottom`).toBe(rectBottom(rect));
        expect(grown.x, `${where}: resize keeps x`).toBe(rect.x);
        expect(grown.width, where).toBe(MAIN_CONTENT_WIDTH);
        expect(resizeAnchored(grown, height, 'bottom', wa, preset.frame, grid), where).toEqual(
          rect,
        );

        // The detail window: 600 wide, its left and anchored edges on the grid, gap >= 6.
        const p = detailPlacement({
          mainOuter: outer,
          workArea: wa,
          anchor: 'bottom',
          frame: preset.frame,
          grid,
        });
        expect(p.content.width, where).toBe(DETAIL_CONTENT_WIDTH);
        expect(onGridX(p.content.x) && onGridX(rectRight(p.content)), `${where}: detail x`).toBe(
          true,
        );
        expect(onGridY(rectBottom(p.content)), `${where}: detail bottom`).toBe(true);
        expect(p.outer.x, `${where}: detail inside`).toBeGreaterThanOrEqual(wa.x);
        expect(rectBottom(p.outer), `${where}: detail inside`).toBeLessThanOrEqual(rectBottom(wa));
        if (p.side === 'left') {
          const gap = outer.x - rectRight(p.outer);
          expect(gap, `${where}: gap`).toBeGreaterThanOrEqual(6);
          expect(gap, `${where}: gap`).toBeLessThanOrEqual(6 + slack);
        }
      }
    });
  }

  it('places the 125 % and 150 % presets on the expected pixels', () => {
    const at125 = DISPLAY_PRESETS['1366x768@125'];
    const r125 = mainContentRect({
      workArea: at125.workArea,
      frame: at125.frame,
      anchor: 'bottom',
      height: 349,
      grid: pixelGrid(display(1, at125.bounds, at125.workArea, 1.25)),
    });
    // 642 DIP = 802.5 px before; 640 DIP = 800 px, 440 DIP = 550 px. The top edge grows from
    // 203 (253.75 px) to 200 (250 px): 352 DIP = 440 px tall.
    expect(r125).toEqual({ x: 640, y: 200, width: 440, height: 352 });
    const at150 = DISPLAY_PRESETS['1920x1080@150'];
    const r150 = mainContentRect({
      workArea: at150.workArea,
      frame: at150.frame,
      anchor: 'bottom',
      height: 349,
      grid: pixelGrid(display(1, at150.bounds, at150.workArea, 1.5)),
    });
    // 829 DIP = 1243.5 px before; 828 DIP = 1242 px. 349 DIP would be 523.5 px tall (Windows
    // gave such a window one DIP less than asked): the top edge grows to 310, 350 DIP = 525 px.
    expect(r150).toEqual({ x: 828, y: 310, width: 440, height: 350 });
  });

  it('snaps the top edge downwards when anchored on top (macOS, Linux top panel)', () => {
    const wa: Rect = { x: 0, y: 27, width: 1229, height: 741 };
    const grid: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1.25 };
    const rect = mainContentRect({
      workArea: wa,
      frame: ZERO_FRAME,
      anchor: 'top',
      height: 400,
      grid,
    });
    expect(rect.y).toBe(40);
    expect(isOnPixelGrid(rect.x, 0, 1.25)).toBe(true);
    const grown = resizeAnchored(rect, 520, 'top', wa, ZERO_FRAME, grid);
    expect(grown.y).toBe(rect.y);
    // The free (bottom) edge grows onto the grid: 401 DIP from 40 ends at 441 (551.25 px), so
    // the window is 404 DIP (505 px) tall, at the corner and when resized.
    const odd = mainContentRect({
      workArea: wa,
      frame: ZERO_FRAME,
      anchor: 'top',
      height: 401,
      grid,
    });
    expect(odd).toEqual({ ...rect, height: 404 });
    expect(resizeAnchored(grown, 401, 'top', wa, ZERO_FRAME, grid)).toEqual(odd);
  });

  it('grows the free edge onto the grid when centred (onboarding)', () => {
    const wa: Rect = { x: 0, y: 0, width: 1280, height: 672 };
    const grid: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1.5 };
    const r = centredContentRect({
      workArea: wa,
      frame: ZERO_FRAME,
      anchor: 'bottom',
      height: 431,
      grid,
    });
    expect(isOnPixelGrid(r.y, 0, 1.5) && isOnPixelGrid(rectBottom(r), 0, 1.5)).toBe(true);
    expect(r.height).toBe(432);
  });

  it('snaps a rect the user moved, on a display with negative coordinates', () => {
    const left = display(
      2,
      { x: -1093, y: 0, width: 1093, height: 614 },
      { x: -1093, y: 0, width: 1093, height: 566 },
      1.25,
    );
    const grid = pixelGrid(left);
    const moved: Rect = { x: -700, y: 101, width: 440, height: 300 };
    const r = resizeAnchored(moved, 320, 'bottom', left.workArea, WIN_FRAME, grid);
    expect(isOnPixelGrid(r.x, -1093, 1.25)).toBe(true);
    expect(moved.x - r.x).toBeGreaterThanOrEqual(0);
    expect(moved.x - r.x).toBeLessThanOrEqual(3);
    expect(isOnPixelGrid(rectBottom(r), 0, 1.25)).toBe(true);
    expect(rectBottom(moved) - rectBottom(r)).toBeLessThanOrEqual(3);
  });
});

describe('stale pixel size', () => {
  const grid125: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1.25 };
  const requested: Rect = { x: 640, y: 204, width: 440, height: 348 };

  it('asks for a re-apply when a whole-pixel rect came out wider', () => {
    // Placed off-grid before (553 px), then the same DIP size on the grid: Electron kept 553.
    expect(needsSizeReapply(requested, { ...requested, width: 441, height: 349 }, grid125)).toBe(
      true,
    );
    expect(needsSizeReapply(requested, { ...requested, height: 349 }, grid125)).toBe(false);
  });

  it('does not when the rect cannot be whole pixels or the scale is an integer', () => {
    const offGrid = { ...requested, x: 641 };
    expect(needsSizeReapply(offGrid, { ...offGrid, width: 441 }, grid125)).toBe(false);
    const oddWidth = { ...requested, width: 441 };
    expect(needsSizeReapply(oddWidth, { ...oddWidth, width: 442 }, grid125)).toBe(false);
    const grid1: PixelGrid = { origin: { x: 0, y: 0 }, scaleFactor: 1 };
    expect(needsSizeReapply(requested, { ...requested, width: 441 }, grid1)).toBe(false);
    expect(needsSizeReapply(requested, { ...requested, width: 441 }, null)).toBe(false);
  });
});

describe('user move detection', () => {
  const at: Rect = { x: 640, y: 203, width: 440, height: 349 };

  it('ignores readback rounding of 1 DIP, sees anything more', () => {
    expect(movedAway({ ...at, x: 641 }, at)).toBe(false);
    expect(movedAway({ ...at, y: 202 }, at)).toBe(false);
    expect(movedAway({ ...at, x: 642 }, at)).toBe(true);
    expect(movedAway({ ...at, x: 300, y: 200 }, at)).toBe(true);
    // A height change alone is not a move.
    expect(movedAway({ ...at, height: 460 }, at)).toBe(false);
  });
});
