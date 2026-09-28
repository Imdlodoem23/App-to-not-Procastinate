/**
 * Surface geometry (PROMPT §10): the OSD centred 300 DIP above the bottom of the work area, the
 * mini timer's default corner and remembered place, the Nuclear overlay on every display, and
 * the main window centred during the onboarding.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listRunningProcesses,
  processBaseName,
  toRunningProcesses,
} from '../../../src/main/platform/processes';
import { progressState } from '../../../src/main/platform/progress';
import { SOUND_MAX_BYTES, loadSound } from '../../../src/main/platform/sounds';
import type { ExecResult } from '../../../src/main/system/exec';
import { centredContentRect, type DisplayInfo } from '../../../src/main/windows/geometry';
import {
  MINI_TIMER_DEFAULT_INSET,
  defaultMiniTimerPosition,
  miniTimerBounds,
} from '../../../src/main/windows/mini-timer-geometry';
import { heartbeatDisplays, overlayPlacements } from '../../../src/main/windows/nuclear-geometry';
import { OSD_WINDOW_SIZE, osdBounds, osdDisplay } from '../../../src/main/windows/osd-geometry';
import { makeAchievements, HARNESS_NOW } from '../../../src/shared/fixtures';
import { OSD_LAYOUT } from '../../../src/shared/platform';
import { MINI_TIMER_SIZE } from '../../../src/shared/prefs';

const PRIMARY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
};
const LEFT: DisplayInfo = {
  id: 2,
  bounds: { x: -1366, y: 200, width: 1366, height: 768 },
  workArea: { x: -1366, y: 200, width: 1366, height: 728 },
  scaleFactor: 1.25,
};

describe('OSD placement', () => {
  it('is centred, its bottom 300 DIP above the work area bottom', () => {
    const b = osdBounds(PRIMARY.workArea);
    expect(b.width).toBe(OSD_WINDOW_SIZE.width);
    expect(b.x + b.width / 2).toBe(960);
    expect(b.y + b.height).toBe(1040 - OSD_LAYOUT.bottomOffset);
  });

  it('follows a display with negative coordinates', () => {
    const b = osdBounds(LEFT.workArea);
    expect(b.x).toBe(Math.round(-1366 + (1366 - b.width) / 2));
    expect(b.y + b.height).toBe(200 + 728 - 300);
  });

  it('never leaves a small work area', () => {
    const b = osdBounds({ x: 0, y: 0, width: 800, height: 250 });
    expect(b.width).toBe(800 - 32);
    expect(b.y).toBe(0);
    expect(b.x).toBe(16);
  });

  it('shows where the pointer is', () => {
    expect(osdDisplay([PRIMARY, LEFT], { x: -100, y: 500 }).id).toBe(2);
    expect(osdDisplay([PRIMARY, LEFT], { x: 100, y: 100 }).id).toBe(1);
  });
});

describe('mini timer placement', () => {
  it('defaults to the top-right corner of the primary display', () => {
    expect(defaultMiniTimerPosition(PRIMARY.workArea)).toEqual({ x: 1720, y: 24 });
    expect(miniTimerBounds(null, [PRIMARY], PRIMARY)).toEqual({
      x: 1920 - MINI_TIMER_SIZE.width - MINI_TIMER_DEFAULT_INSET.right,
      y: 24,
      width: 180,
      height: 44,
    });
  });

  it('keeps a remembered place, also on a second display', () => {
    expect(miniTimerBounds({ x: 100, y: 500 }, [PRIMARY, LEFT], PRIMARY)).toMatchObject({
      x: 100,
      y: 500,
    });
    expect(miniTimerBounds({ x: -1300, y: 300 }, [PRIMARY, LEFT], PRIMARY)).toMatchObject({
      x: -1300,
      y: 300,
    });
  });

  it('comes back on screen when its display is gone', () => {
    const b = miniTimerBounds({ x: -1300, y: 300 }, [PRIMARY], PRIMARY);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
    const below = miniTimerBounds({ x: 500, y: 5000 }, [PRIMARY], PRIMARY);
    expect(below.y + below.height).toBeLessThanOrEqual(1040);
  });
});

describe('Nuclear overlay', () => {
  it('covers every display completely, taskbar included', () => {
    expect(overlayPlacements([PRIMARY, LEFT])).toEqual([
      { displayId: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { displayId: 2, bounds: { x: -1366, y: 200, width: 1366, height: 768 } },
    ]);
    expect(heartbeatDisplays(0)).toBe(1);
    expect(heartbeatDisplays(3)).toBe(3);
    expect(heartbeatDisplays(40)).toBe(16);
  });
});

describe('onboarding: the main window centred', () => {
  it('centres the outer window in the work area', () => {
    const frame = { top: 32, right: 1, bottom: 1, left: 1 };
    const r = centredContentRect({
      workArea: PRIMARY.workArea,
      frame,
      anchor: 'bottom',
      height: 500,
    });
    expect(r.width).toBe(440);
    expect(r.height).toBe(500);
    const outerX = r.x - frame.left;
    const outerY = r.y - frame.top;
    // Whole DIP: the centre is within half a DIP of the work area's.
    expect(Math.abs(outerX + (440 + 2) / 2 - 960)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(outerY + (500 + 33) / 2 - 520)).toBeLessThanOrEqual(0.5);
  });

  it('snaps to the pixel grid at 125 % and stays inside a short work area', () => {
    const r = centredContentRect({
      workArea: LEFT.workArea,
      frame: { top: 0, right: 0, bottom: 0, left: 0 },
      anchor: 'top',
      height: 2000,
      grid: { origin: { x: LEFT.bounds.x, y: LEFT.bounds.y }, scaleFactor: 1.25 },
    });
    expect(r.y).toBeGreaterThanOrEqual(200);
    expect(((r.x - LEFT.bounds.x) * 1.25) % 1).toBe(0);
    expect(r.height).toBeLessThanOrEqual(728);
  });
});

describe('progress', () => {
  it('counts achievements and names the fresh ones', () => {
    const achievements = makeAchievements(HARNESS_NOW);
    const p = progressState({
      achievements,
      events: [],
      today: { focusMinutes: 42, goalMinutes: 60 },
      seen: { epoch: 'ep', ids: ['first-block'] },
      epoch: 'ep',
    });
    expect(p).toEqual({
      mascot: 'plant',
      achieved: 3,
      total: 8,
      fresh: ['streak-7', 'clean-week'],
    });
    expect(
      progressState({
        achievements,
        events: [],
        today: { focusMinutes: 60, goalMinutes: 60 },
        seen: { epoch: 'ep', ids: ['first-block', 'streak-7', 'clean-week'] },
        epoch: 'ep',
      }),
    ).toMatchObject({ mascot: 'tree', fresh: [] });
  });
});

describe('running processes', () => {
  it('keeps base names, drops protected ones and finds catalog apps', () => {
    expect(processBaseName('/Applications/Discord.app/Contents/MacOS/Discord')).toBe('Discord');
    expect(processBaseName('C:\\Program Files\\Steam\\steam.exe')).toBe('steam.exe');
    const list = toRunningProcesses(
      ['Discord.exe', 'explorer.exe', 'svchost.exe', 'Discord.exe', 'mygame.exe'],
      'win32',
    );
    expect(list.map((p) => p.name)).toEqual(['Discord.exe', 'mygame.exe']);
    expect(list.find((p) => p.name === 'Discord.exe')?.appId).toBe('discord');
    expect(list.find((p) => p.name === 'mygame.exe')?.appId).toBeNull();
  });

  it('runs one fixed command per OS', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const exec = async (file: string, args: readonly string[]): Promise<ExecResult> => {
      calls.push([file, args]);
      const stdout =
        file === 'tasklist'
          ? '"Discord.exe","1234","Console","1","120.000 K"\r\n'
          : 'Discord\nbash\n';
      return { code: 0, stdout, stderr: '', error: null };
    };
    expect((await listRunningProcesses('win32', exec)).map((p) => p.name)).toEqual(['Discord.exe']);
    await listRunningProcesses('darwin', exec);
    await listRunningProcesses('linux', exec);
    expect(calls).toEqual([
      ['tasklist', ['/fo', 'csv', '/nh']],
      ['/bin/ps', ['-axo', 'comm=']],
      ['ps', ['-eo', 'comm=']],
    ]);
  });
});

describe('sounds', () => {
  const dir = join(__dirname, '..', '..', '..', 'resources', 'sounds');

  it.skipIf(!existsSync(join(dir, 'lluvia.wav')))(
    'loads a loop from resources/sounds',
    async () => {
      const data = await loadSound(dir, 'rain');
      expect(data.mime).toBe('audio/wav');
      expect(data.bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(data.bytes.slice(0, 4))).toBe('RIFF');
      expect(data.bytes.byteLength).toBeLessThan(SOUND_MAX_BYTES);
    },
  );

  it('fails for a missing folder', async () => {
    await expect(loadSound('/nonexistent/sounds', 'rain')).rejects.toThrow();
  });
});
