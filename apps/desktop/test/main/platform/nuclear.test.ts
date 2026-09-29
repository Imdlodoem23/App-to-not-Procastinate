/**
 * The Nuclear overlay's safety rules (PROMPT §4 «Nuclear», §10 «Nuclear»):
 *
 * - it stands only on trusted data: `nuclearActive` with the link `ok` and the end still ahead
 *   (a guardian that stopped answering, or a passed end, hides it), and it is looked at again
 *   just after the end;
 * - quits the user can repeat are refused while it lasts; the OS going away is not;
 * - the tray trades «Salir» for «Salida de emergencia…»;
 * - its windows are focusable, the one under the pointer takes the focus, and they are
 *   destroyed (not hidden) when Nuclear ends.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAY_ITEM, trayActionForItem, trayMenu } from '../../../src/main/tray/model';
import type { DisplaySource } from '../../../src/main/windows/display-source';
import type { DisplayInfo, Point, Rect } from '../../../src/main/windows/geometry';
import { NuclearOverlay } from '../../../src/main/windows/nuclear';
import {
  createWin32CloakProbe,
  DWMWA_CLOAKED,
  hwndOf,
  loadCloakProbe,
} from '../../../src/main/windows/nuclear-cloak';
import { overlayFocusDisplay } from '../../../src/main/windows/nuclear-geometry';
import {
  NUCLEAR_ARG,
  NUCLEAR_END_GRACE_MS,
  nuclearRecheckDelay,
  nuclearTrusted,
  onSecondInstance,
  quitOriginOfSignal,
  quitRefused,
  quitSignals,
} from '../../../src/main/windows/nuclear-lock';
import { HARNESS_NOW, harnessFixture } from '../../../src/shared/fixtures';
import { nuclearEndsAt, type UiSnapshot } from '../../../src/shared/ui-state';

const MIN = 60_000;

function nuclearSnapshot(): UiSnapshot {
  return harnessFixture('nuclear').snapshot;
}

function endOf(snapshot: UiSnapshot): number {
  const endsAt = nuclearEndsAt(snapshot.state);
  if (!endsAt) throw new Error('the nuclear fixture has an end');
  return Date.parse(endsAt);
}

describe('the overlay stands only on trusted data', () => {
  it('shows while the guardian says so, the link is ok and the end is ahead', () => {
    const snapshot = nuclearSnapshot();
    expect(snapshot.link.status).toBe('ok');
    expect(nuclearTrusted(snapshot, HARNESS_NOW)).toBe(true);
  });

  it('hides when the guardian stops answering (the poller keeps the last state)', () => {
    const snapshot = nuclearSnapshot();
    const down: UiSnapshot = {
      ...snapshot,
      link: { ...snapshot.link, status: 'down', reason: 'unreachable' },
    };
    expect(down.state?.nuclearActive).toBe(true);
    expect(nuclearTrusted(down, HARNESS_NOW)).toBe(false);
    expect(
      nuclearTrusted(
        { ...snapshot, link: { ...snapshot.link, status: 'connecting' } },
        HARNESS_NOW,
      ),
    ).toBe(false);
    expect(nuclearRecheckDelay(down, HARNESS_NOW)).toBeNull();
  });

  it('hides once the punishment’s end passed, even if nothing new arrived', () => {
    const snapshot = nuclearSnapshot();
    const end = endOf(snapshot);
    expect(nuclearTrusted(snapshot, end - 1)).toBe(true);
    expect(nuclearTrusted(snapshot, end)).toBe(false);
    expect(nuclearTrusted(snapshot, end + 5 * MIN)).toBe(false);
  });

  it('is looked at again just after the end', () => {
    const snapshot = nuclearSnapshot();
    const end = endOf(snapshot);
    expect(nuclearRecheckDelay(snapshot, HARNESS_NOW)).toBe(
      end - HARNESS_NOW + NUCLEAR_END_GRACE_MS,
    );
    expect(nuclearRecheckDelay(snapshot, end + 1)).toBeNull();
  });

  it('never shows without a Nuclear punishment', () => {
    const idle = harnessFixture('idle').snapshot;
    expect(nuclearTrusted(idle, HARNESS_NOW)).toBe(false);
    expect(nuclearTrusted({ ...idle, state: null }, HARNESS_NOW)).toBe(false);
  });
});

describe('quits while Nuclear lasts', () => {
  it('refuses what the user can repeat, lets the OS go away', () => {
    expect(quitRefused(true, 'user')).toBe(true);
    expect(quitRefused(true, 'os')).toBe(false);
    expect(quitRefused(false, 'user')).toBe(false);
  });

  it('a logout signal is the OS going away (Linux, macOS), never refused', () => {
    expect(quitSignals('linux')).toEqual(['SIGTERM', 'SIGHUP']);
    expect(quitSignals('darwin')).toEqual(['SIGTERM', 'SIGHUP']);
    expect(quitSignals('win32')).toEqual([]);
    expect(quitOriginOfSignal('SIGTERM')).toBe('os');
    expect(quitOriginOfSignal('SIGHUP')).toBe('os');
    expect(quitOriginOfSignal('SIGINT')).toBe('user');
    expect(quitRefused(true, quitOriginOfSignal('SIGTERM'))).toBe(false);
  });

  it('the tray offers «Salida de emergencia…» instead of «Salir»', () => {
    const snapshot = nuclearSnapshot();
    const ids = (s: UiSnapshot, now: number): string[] => trayMenu(s, now).map((i) => i.id);
    expect(ids(snapshot, HARNESS_NOW)).toContain(TRAY_ITEM.emergency);
    expect(ids(snapshot, HARNESS_NOW)).not.toContain(TRAY_ITEM.quit);
    const item = trayMenu(snapshot, HARNESS_NOW).find((i) => i.id === TRAY_ITEM.emergency);
    expect(item).toMatchObject({ label: 'Salida de emergencia…', enabled: true });
    expect(trayActionForItem(TRAY_ITEM.emergency)).toEqual({ type: 'emergency' });
    // Guardian gone or punishment over: «Salir» is back.
    const down: UiSnapshot = { ...snapshot, link: { ...snapshot.link, status: 'down' } };
    expect(ids(down, HARNESS_NOW)).toContain(TRAY_ITEM.quit);
    expect(ids(snapshot, endOf(snapshot) + 1)).toContain(TRAY_ITEM.quit);
    expect(ids(harnessFixture('idle').snapshot, HARNESS_NOW)).not.toContain(TRAY_ITEM.emergency);
  });
});

// ---------------------------------------------------------------------------------------
// The overlay windows (a fake BrowserWindow: only what `NuclearOverlay` calls)
// ---------------------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class FakeWindow {
  static nextId = 1;
  readonly id = FakeWindow.nextId++;
  visible = false;
  minimized = false;
  destroyed = false;
  focused = false;
  bounds: Rect;
  readonly listeners = new Map<string, Listener[]>();
  readonly webContents = {
    id: this.id,
    on: (): void => undefined,
    reload: (): void => undefined,
  };

  constructor(readonly options: BrowserWindowConstructorOptions) {
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
    };
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  getBounds(): Rect {
    return { ...this.bounds };
  }
  setBounds(b: Rect): void {
    this.bounds = { ...b };
  }
  showInactive(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  minimize(): void {
    this.minimized = true;
    this.emit('minimize');
  }
  restore(): void {
    this.minimized = false;
  }
  focus(): void {
    this.focused = true;
  }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  setBackgroundColor(): void {}
  destroy(): void {
    if (this.destroyed) return;
    this.visible = false;
    this.destroyed = true;
    this.emit('closed');
  }
}

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

function overlay(
  cursor: Point,
  keepFocus = false,
  mac: { hidden: boolean; shows: number } | null = null,
  /** Windows: the windows DWM cloaked (left on another virtual desktop). */
  cloaked: Set<FakeWindow> | null = null,
) {
  const created: FakeWindow[] = [];
  const statuses: string[] = [];
  const logs: string[] = [];
  const displays: DisplaySource = {
    fake: true,
    all: () => [PRIMARY, LEFT],
    cursor: () => cursor,
    fallbackFrame: () => null,
    onChanged: () => () => undefined,
  };
  const nuclear = new NuclearOverlay({
    create: (_kind, extra) => {
      const win = new FakeWindow(extra);
      created.push(win);
      return win as unknown as BrowserWindow;
    },
    displays,
    backgroundColor: () => 'Canvas',
    onVisibility: () => undefined,
    onStatus: (s) => statuses.push(`${s.overlay}:${s.displays}`),
    log: (event, fields) => logs.push(`${event}:${String(fields['reason'] ?? '')}`),
    isQuitting: () => false,
    keepFocus: () => keepFocus,
    ...(cloaked
      ? { cloaked: (win: BrowserWindow) => cloaked.has(win as unknown as FakeWindow) }
      : {}),
    ...(mac
      ? {
          appHidden: () => mac.hidden,
          showApp: () => {
            mac.shows += 1;
            mac.hidden = false;
          },
        }
      : {}),
    watchdogMs: 1_000,
  });
  return { nuclear, created, statuses, logs };
}

describe('the overlay windows', () => {
  it('pick the display under the pointer (else the nearest) for the focus', () => {
    expect(overlayFocusDisplay([PRIMARY, LEFT], { x: -100, y: 500 })).toBe(2);
    expect(overlayFocusDisplay([PRIMARY, LEFT], { x: 3000, y: 10 })).toBe(1);
    expect(overlayFocusDisplay([], { x: 0, y: 0 })).toBeNull();
  });

  it('are focusable, and the one under the pointer takes the focus', () => {
    const { nuclear, created, statuses } = overlay({ x: -300, y: 400 });
    nuclear.sync(true);
    expect(created).toHaveLength(2);
    expect(created.every((w) => w.options.focusable === true)).toBe(true);
    expect(created.every((w) => w.visible)).toBe(true);
    const left = created.find((w) => w.bounds.x === -1366);
    const primary = created.find((w) => w.bounds.x === 0);
    expect(left?.focused).toBe(true);
    expect(primary?.focused).toBe(false);
    expect(statuses.at(-1)).toBe('shown:2');
    // A later sync (every snapshot) does not steal the focus again.
    if (left) left.focused = false;
    nuclear.sync(true);
    expect(left?.focused).toBe(false);
  });

  it('leave the focus to Emergencia above them', () => {
    const { nuclear, created } = overlay({ x: 10, y: 10 }, true);
    nuclear.sync(true);
    expect(created.some((w) => w.focused)).toBe(false);
  });

  it('refuse to close while Nuclear lasts', () => {
    const { nuclear, created } = overlay({ x: 10, y: 10 });
    nuclear.sync(true);
    let prevented = false;
    created[0]?.emit('close', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
  });

  it('are destroyed when Nuclear ends, and made again for the next one', () => {
    const { nuclear, created, statuses } = overlay({ x: 10, y: 10 });
    nuclear.sync(true);
    nuclear.sync(false);
    expect(created.every((w) => w.destroyed)).toBe(true);
    expect(nuclear.all()).toEqual([]);
    expect(statuses.at(-1)).toBe('hidden:0');
    nuclear.sync(true);
    expect(created).toHaveLength(4);
    expect(nuclear.all()).toHaveLength(2);
    expect(statuses.at(-1)).toBe('shown:2');
  });

  describe('taken off the screen without a hide event', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a window manager minimise is undone at once', async () => {
      const { nuclear, created, statuses } = overlay({ x: 10, y: 10 });
      nuclear.sync(true);
      created[0]?.minimize();
      await new Promise((resolve) => setImmediate(resolve));
      expect(created[0]?.minimized).toBe(false);
      expect(created[0]?.visible).toBe(true);
      expect(statuses.at(-1)).toBe('shown:2');
      nuclear.destroy();
    });

    it('the watchdog re-shows windows, counts only live ones, and shows a hidden app', () => {
      vi.useFakeTimers();
      const mac = { hidden: false, shows: 0 };
      const { nuclear, created, statuses } = overlay({ x: 10, y: 10 }, false, mac);
      nuclear.sync(true);
      expect(nuclear.liveCount()).toBe(2);
      // Minimised without the event reaching us, and another one hidden.
      const [a, b] = created;
      if (a) a.minimized = true;
      if (b) b.visible = false;
      expect(nuclear.liveCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(a?.minimized).toBe(false);
      expect(b?.visible).toBe(true);
      expect(nuclear.liveCount()).toBe(2);
      // macOS «Hide» (Cmd+H): nothing is live until the app shows again.
      mac.hidden = true;
      expect(nuclear.liveCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(mac.shows).toBe(1);
      expect(nuclear.liveCount()).toBe(2);
      expect(statuses.at(-1)).toBe('shown:2');
      // Nuclear over: no watchdog left.
      nuclear.sync(false);
      if (a) a.visible = false;
      vi.advanceTimersByTime(5_000);
      expect(mac.shows).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a window left on another virtual desktop (cloaked) is not live and is made again', () => {
      vi.useFakeTimers();
      const cloaked = new Set<FakeWindow>();
      const { nuclear, created, statuses, logs } = overlay({ x: 10, y: 10 }, false, null, cloaked);
      nuclear.sync(true);
      expect(nuclear.liveCount()).toBe(2);
      // Ctrl+Win+D: both stay «visible» and not minimised, but DWM cloaks them.
      const [a, b] = created;
      if (!a || !b) throw new Error('two overlay windows');
      cloaked.add(a);
      cloaked.add(b);
      expect(a.visible && !a.minimized).toBe(true);
      expect(nuclear.liveCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      // Destroyed and made again: the new ones are on the current desktop.
      expect(a.destroyed && b.destroyed).toBe(true);
      expect(created).toHaveLength(4);
      expect(nuclear.all()).toHaveLength(2);
      expect(nuclear.all().some((w) => (w as unknown as FakeWindow) === a)).toBe(false);
      expect(nuclear.liveCount()).toBe(2);
      expect(created.slice(2).every((w) => w.visible)).toBe(true);
      expect(created.slice(2).some((w) => w.focused)).toBe(true);
      expect(logs.filter((l) => l === 'nuclear_overlay_restored:cloaked')).toHaveLength(2);
      expect(statuses.at(-1)).toBe('shown:2');
      // Only the cloaked one is replaced.
      const c = created[2];
      if (c) cloaked.add(c);
      vi.advanceTimersByTime(1_000);
      expect(created).toHaveLength(5);
      expect(created[3]?.destroyed).toBe(false);
      nuclear.destroy();
    });

    it('a guardian relaunch makes every window again, shows the app and focuses', () => {
      const mac = { hidden: true, shows: 0 };
      const { nuclear, created, statuses } = overlay({ x: -300, y: 400 }, false, mac);
      // Off: a relaunch covers nothing by itself (only trusted data does).
      nuclear.relaunch();
      expect(created).toHaveLength(0);
      nuclear.sync(true);
      expect(statuses.at(-1)).toBe('hidden:0');
      nuclear.relaunch();
      expect(mac.shows).toBe(1);
      expect(created).toHaveLength(4);
      expect(created.slice(0, 2).every((w) => w.destroyed)).toBe(true);
      expect(nuclear.all()).toHaveLength(2);
      const left = created.slice(2).find((w) => w.bounds.x === -1366);
      expect(left?.focused).toBe(true);
      expect(statuses.at(-1)).toBe('shown:2');
      nuclear.destroy();
    });

    it('an overlay that cannot be put back reads hidden (the heartbeat stops)', () => {
      vi.useFakeTimers();
      const mac = { hidden: false, shows: 0 };
      const { nuclear, statuses } = overlay({ x: 10, y: 10 }, false, mac);
      nuclear.sync(true);
      // An app that stays hidden whatever `app.show()` does.
      mac.hidden = true;
      Object.defineProperty(mac, 'hidden', { get: () => true, set: () => undefined });
      vi.advanceTimersByTime(1_000);
      expect(statuses.at(-1)).toBe('hidden:0');
      nuclear.destroy();
    });
  });
});

describe('the Windows cloak probe', () => {
  const win = (handle: Buffer, destroyed = false) =>
    ({
      isDestroyed: () => destroyed,
      getNativeWindowHandle: () => handle,
    }) as unknown as BrowserWindow;
  const handle64 = (value: bigint): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    return b;
  };

  it('reads the HWND from the native handle (32 and 64 bit)', () => {
    expect(hwndOf(handle64(0x1234n))).toBe(0x1234n);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(0xabcd);
    expect(hwndOf(b)).toBe(0xabcdn);
    expect(hwndOf(Buffer.alloc(0))).toBeNull();
  });

  it('asks DWMWA_CLOAKED and reads any failure as not cloaked', () => {
    const calls: unknown[][] = [];
    let cloak = 2; // DWM_CLOAKED_SHELL: another virtual desktop
    let hr = 0;
    const fakeKoffi = {
      load: (name: string) => {
        expect(name).toBe('dwmapi.dll');
        return {
          func: () => (hwnd: bigint, attr: number, out: number[], size: number) => {
            calls.push([hwnd, attr, size]);
            out[0] = cloak;
            return hr;
          },
        };
      },
    };
    const probe = createWin32CloakProbe(
      fakeKoffi as unknown as Parameters<typeof createWin32CloakProbe>[0],
    );
    expect(probe(win(handle64(42n)))).toBe(true);
    expect(calls[0]).toEqual([42n, DWMWA_CLOAKED, 4]);
    cloak = 0;
    expect(probe(win(handle64(42n)))).toBe(false);
    cloak = 2;
    hr = -2147024809; // E_INVALIDARG
    expect(probe(win(handle64(42n)))).toBe(false);
    hr = 0;
    expect(probe(win(handle64(42n), true))).toBe(false);
    expect(probe(win(handle64(0n)))).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('loads only on Windows, and a failed load is no probe', async () => {
    const load = vi.fn(() => Promise.reject(new Error('no koffi')));
    expect(await loadCloakProbe('linux', load)).toBeNull();
    expect(await loadCloakProbe('darwin', load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(await loadCloakProbe('win32', load)).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });
});

describe('a second launch', () => {
  const route = (argv: string[]) => {
    const calls: string[] = [];
    onSecondInstance(argv, {
      refresh: () => calls.push('refresh'),
      nuclearRelaunch: () => calls.push('relaunch'),
      showMain: () => calls.push('show-main'),
    });
    return calls;
  };

  it('the guardian’s Nuclear relaunch refreshes and makes the overlay again, no main window', () => {
    expect(route(['Céntrate.exe', NUCLEAR_ARG])).toEqual(['refresh', 'relaunch']);
  });

  it('any other launch shows the main window', () => {
    expect(route(['Céntrate.exe'])).toEqual(['show-main']);
    expect(route(['Céntrate.exe', '--hidden'])).toEqual(['show-main']);
  });
});
