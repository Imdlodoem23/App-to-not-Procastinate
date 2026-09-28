/**
 * The active-window layer (PROMPT §5 capa 4): which titles count, when they are reported, the
 * fixed xprop argv on Linux, and the polling that only runs while a block is active.
 */
import type { AttemptResponse, GuardianStateResponse } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { ActiveWindowLayer } from '../../../src/main/activewin/layer';
import {
  ACTIVE_WINDOW_POLL_MS,
  ACTIVE_WINDOW_REFRESH_MS,
  ReportThrottle,
  browserOfProcess,
  hasActiveBlock,
  isServiceCovered,
  serviceOfWindow,
} from '../../../src/main/activewin/match';
import type { ForegroundRead, ForegroundReader } from '../../../src/main/activewin/reader';
import { createForegroundReader } from '../../../src/main/activewin/reader';
import {
  parseActiveWindowId,
  parseWindowProperties,
  readX11Foreground,
  unescapeXpropString,
  x11Available,
} from '../../../src/main/activewin/xprop';
import { createManualClock } from '../../../src/main/guardian/clock';
import type { ExecOptions, ExecResult } from '../../../src/main/system/exec';
import type { ActiveWindowStatus } from '../../../src/shared/platform';
import { HARNESS_NOW, makeBlock, makeGuardianState } from '../../../src/shared/fixtures';
import { run } from '../guardian/helpers';

const NOW = HARNESS_NOW;
const MIN = 60_000;

function stateWith(...blocks: Parameters<typeof makeBlock>[0][]): GuardianStateResponse {
  return makeGuardianState(NOW, { blocks: blocks.map((b) => makeBlock(b, NOW)) });
}

const youtubeBlock = stateWith({
  n: 1,
  services: ['youtube'],
  mode: 'strict',
  leftMs: 30 * MIN,
  elapsedMs: 10 * MIN,
});

describe('which windows count', () => {
  it('reads the site name where browsers put it, never a page about it', () => {
    expect(
      serviceOfWindow({ title: '(3) Lo-fi mix - YouTube - Google Chrome', process: 'chrome.exe' }),
    ).toBe('youtube');
    expect(
      serviceOfWindow({ title: 'YouTube - Wikipedia - Mozilla Firefox', process: 'firefox' }),
    ).toBeNull();
    expect(serviceOfWindow({ title: 'Instagram', process: 'Google Chrome' })).toBe('instagram');
    expect(serviceOfWindow({ title: '', process: 'chrome.exe' })).toBeNull();
  });

  it('ignores protected processes whatever their title says', () => {
    expect(serviceOfWindow({ title: 'YouTube', process: 'explorer.exe' })).toBeNull();
    expect(serviceOfWindow({ title: 'YouTube', process: 'Finder' })).toBeNull();
  });

  it('reports only services an active block covers', () => {
    expect(isServiceCovered(youtubeBlock, 'youtube')).toBe(true);
    expect(isServiceCovered(youtubeBlock, 'instagram')).toBe(false);
    const social = stateWith({
      n: 2,
      categories: ['social'],
      mode: 'normal',
      leftMs: MIN,
      elapsedMs: MIN,
    });
    expect(isServiceCovered(social, 'instagram')).toBe(true);
    const exam = stateWith({ n: 3, mode: 'exam', leftMs: MIN, elapsedMs: MIN });
    expect(isServiceCovered(exam, 'netflix')).toBe(true);
    expect(isServiceCovered(null, 'youtube')).toBe(false);
    expect(isServiceCovered(youtubeBlock, 'not-a-service')).toBe(false);
  });

  it('a redeemed allowance opens its service', () => {
    const opened: GuardianStateResponse = {
      ...youtubeBlock,
      allowances: [
        {
          id: 'alw_x',
          offerId: 'youtube-15',
          serviceId: 'youtube',
          minutes: 15,
          cost: 150,
          startedAt: new Date(NOW).toISOString(),
          endsAt: new Date(NOW + 15 * MIN).toISOString(),
          status: 'active',
          endedAt: null,
          refund: 0,
        },
      ],
    };
    expect(isServiceCovered(opened, 'youtube')).toBe(false);
  });

  it('knows the browser family of a process', () => {
    expect(browserOfProcess('chrome.exe', 'win32')).toBe('chrome');
    expect(browserOfProcess('firefox', 'linux')).toBe('firefox');
    expect(browserOfProcess('notepad.exe', 'win32')).toBeNull();
    expect(browserOfProcess(null, 'win32')).toBeNull();
  });

  it('watches only while a block is active', () => {
    expect(hasActiveBlock(youtubeBlock)).toBe(true);
    expect(hasActiveBlock(makeGuardianState(NOW))).toBe(false);
    expect(hasActiveBlock(null)).toBe(false);
  });
});

describe('report throttle', () => {
  it('reports a new sighting, then again every 10 s while it stays', () => {
    const t = new ReportThrottle();
    expect(t.shouldReport('youtube', 0)).toBe(true);
    expect(t.shouldReport('youtube', 2_000)).toBe(false);
    expect(t.shouldReport('youtube', ACTIVE_WINDOW_REFRESH_MS)).toBe(true);
    expect(t.shouldReport('instagram', ACTIVE_WINDOW_REFRESH_MS + 1)).toBe(true);
    expect(t.shouldReport(null, ACTIVE_WINDOW_REFRESH_MS + 2)).toBe(false);
    expect(t.shouldReport('instagram', ACTIVE_WINDOW_REFRESH_MS + 3)).toBe(true);
  });
});

describe('Linux X11 through xprop', () => {
  it('parses the active window id and refuses anything else', () => {
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n')).toBe(
      '0x3a00007',
    );
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n')).toBeNull();
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW:  not found.\n')).toBeNull();
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1; rm -rf /\n')).toBe(
      '0x1',
    );
  });

  it('parses the title (UTF-8, escapes) and the pid', () => {
    const out = [
      '_NET_WM_PID(CARDINAL) = 4242',
      '_NET_WM_NAME(UTF8_STRING) = "Vídeo \\"lo-fi\\" - YouTube - Google Chrome"',
      'WM_NAME(STRING) = "fallback"',
    ].join('\n');
    expect(parseWindowProperties(out)).toEqual({
      title: 'Vídeo "lo-fi" - YouTube - Google Chrome',
      pid: 4242,
    });
    expect(parseWindowProperties('_NET_WM_NAME:  not found.\nWM_NAME(STRING) = "Only"\n')).toEqual({
      title: 'Only',
      pid: null,
    });
    expect(unescapeXpropString('V\\303\\255deo')).toBe('Vídeo');
  });

  it('is off on Wayland or without a display', () => {
    expect(x11Available({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' })).toBe(true);
    expect(x11Available({ DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' })).toBe(false);
    expect(x11Available({})).toBe(false);
  });

  it('runs xprop with fixed argv (only a hex window id from its own output)', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec = async (
      file: string,
      args: readonly string[],
      _o: ExecOptions,
    ): Promise<ExecResult> => {
      calls.push({ file, args });
      if (args[0] === '-root') {
        return {
          code: 0,
          stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2c00003\n',
          stderr: '',
          error: null,
        };
      }
      return {
        code: 0,
        stdout: '_NET_WM_NAME(UTF8_STRING) = "Some video - YouTube - Mozilla Firefox"\n',
        stderr: '',
        error: null,
      };
    };
    const r = await readX11Foreground(exec);
    expect(r).toEqual({
      kind: 'window',
      window: { title: 'Some video - YouTube - Mozilla Firefox', process: null },
    });
    expect(calls).toEqual([
      { file: 'xprop', args: ['-root', '_NET_ACTIVE_WINDOW'] },
      { file: 'xprop', args: ['-id', '0x2c00003', '_NET_WM_PID', '_NET_WM_NAME', 'WM_NAME'] },
    ]);
  });

  it('reports unsupported without xprop', async () => {
    const exec = async (): Promise<ExecResult> => ({
      code: null,
      stdout: '',
      stderr: '',
      error: 'ENOENT',
    });
    expect(await readX11Foreground(exec)).toEqual({ kind: 'unsupported' });
    const reader = createForegroundReader({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' },
      exec,
    });
    expect(await reader.read()).toEqual({ kind: 'unsupported' });
    expect(await reader.requestPermission()).toBe('unsupported');
  });
});

describe('the layer', () => {
  function setup(reads: ForegroundRead[]) {
    const clock = createManualClock(NOW);
    const reports: string[] = [];
    const statuses: ActiveWindowStatus[] = [];
    let i = 0;
    let readsDone = 0;
    const reader: ForegroundReader = {
      read: async () => {
        readsDone += 1;
        return reads[Math.min(i++, reads.length - 1)] ?? { kind: 'none' };
      },
      requestPermission: async () => 'granted',
    };
    const response = (blocked: boolean, counted: boolean): AttemptResponse => ({
      blocked,
      counted,
      merged: !counted && blocked,
      attemptId: null,
      pointsDelta: counted ? -10 : 0,
      episodePointsDelta: -10,
      escalationIndex: counted ? 0 : null,
      nextPenalty: 20,
      serviceId: 'youtube',
      block: null,
      reason: blocked ? null : 'not_blocked',
    });
    let reportCount = 0;
    const layer = new ActiveWindowLayer({
      platform: 'win32',
      clock,
      reader,
      report: async (serviceId) => {
        reports.push(serviceId);
        reportCount += 1;
        return response(true, reportCount === 1);
      },
      publish: (s) => statuses.push(s),
      log: () => undefined,
    });
    return { clock, layer, reports, statuses, reads: () => readsDone };
  }

  const youtube: ForegroundRead = {
    kind: 'window',
    window: { title: 'Mix - YouTube - Google Chrome', process: 'chrome.exe' },
  };

  it('never polls without an active block', async () => {
    const t = setup([youtube]);
    t.layer.sync(makeGuardianState(NOW), true);
    await run(t.clock, 60_000);
    expect(t.reads()).toBe(0);
    expect(t.statuses).toEqual([]);
  });

  it('polls every 2 s during a block and reports the covered service', async () => {
    const t = setup([youtube]);
    t.layer.sync(youtubeBlock, true);
    await run(t.clock, 0);
    expect(t.reports).toEqual(['youtube']);
    expect(t.layer.current()).toEqual({
      status: 'ok',
      lastMatch: { serviceId: 'youtube', at: NOW },
    });
    await run(t.clock, ACTIVE_WINDOW_POLL_MS * 4);
    // Still in front: reported again only after 10 s (merged by the guardian).
    expect(t.reports).toEqual(['youtube']);
    await run(t.clock, ACTIVE_WINDOW_REFRESH_MS);
    expect(t.reports.length).toBe(2);
    // The block ends: the layer stops.
    const before = t.reads();
    t.layer.sync(makeGuardianState(NOW), true);
    await run(t.clock, 30_000);
    expect(t.reads()).toBe(before);
    expect(t.layer.current().status).toBe('off');
  });

  it('does not report while the guardian is down', async () => {
    const t = setup([youtube]);
    t.layer.sync(youtubeBlock, false);
    await run(t.clock, 10_000);
    expect(t.reads()).toBe(0);
    expect(t.reports).toEqual([]);
  });

  it('turns itself off where titles cannot be read', async () => {
    const t = setup([{ kind: 'unsupported' }]);
    t.layer.sync(youtubeBlock, true);
    await run(t.clock, 10_000);
    expect(t.reads()).toBe(1);
    expect(t.layer.current().status).toBe('unsupported');
    t.layer.sync(youtubeBlock, true);
    await run(t.clock, 10_000);
    expect(t.reads()).toBe(1);
  });

  it('says a permission is missing and checks again slowly', async () => {
    const t = setup([{ kind: 'needs-permission' }]);
    t.layer.sync(youtubeBlock, true);
    await run(t.clock, 10_000);
    expect(t.layer.current().status).toBe('needs-permission');
    expect(t.reads()).toBe(1);
    await run(t.clock, 30_000);
    expect(t.reads()).toBe(2);
    expect(await t.layer.requestPermission()).toBe('granted');
    expect(t.layer.current().status).toBe('ok');
  });
});
