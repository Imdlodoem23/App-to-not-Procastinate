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
  chooseDisplay,
  clampContentHeight,
  contentFromOuter,
  detailPlacement,
  displayMatching,
  displayNearestPoint,
  frameInsets,
  mainContentRect,
  maxContentHeight,
  outerFromContent,
  rectBottom,
  rectRight,
  resizeAnchored,
  windowLayout,
  type DisplayInfo,
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
