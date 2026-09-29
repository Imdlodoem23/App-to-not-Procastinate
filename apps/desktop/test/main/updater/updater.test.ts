/**
 * The updater (PROMPT §12): which systems install by themselves, version comparison, and the
 * check → download → ready flow against a fake electron-updater.
 */
import { describe, expect, it } from 'vitest';
import {
  UPDATE_DOWNLOAD_PAGE,
  afterCheck,
  isNewerVersion,
  offeredVersion,
  updaterErrorCode,
  updaterMode,
} from '../../../src/main/updater/model';
import { createUpdater, type UpdaterBackend } from '../../../src/main/updater/updater';
import { INITIAL_UPDATER, type UpdaterState } from '../../../src/shared/platform';

describe('mode', () => {
  it('installs on Windows and AppImage, only checks on macOS and .deb, never in dev', () => {
    expect(updaterMode({ platform: 'win32', packaged: true, env: {} })).toBe('full');
    expect(
      updaterMode({ platform: 'linux', packaged: true, env: { APPIMAGE: '/x.AppImage' } }),
    ).toBe('full');
    expect(updaterMode({ platform: 'linux', packaged: true, env: {} })).toBe('check-only');
    expect(updaterMode({ platform: 'darwin', packaged: true, env: {} })).toBe('check-only');
    expect(updaterMode({ platform: 'win32', packaged: false, env: {} })).toBe('unsupported');
    expect(UPDATE_DOWNLOAD_PAGE).toMatch(/^https:\/\//);
  });
});

describe('versions', () => {
  it('compares semver, releases after their pre-releases', () => {
    expect(isNewerVersion('1.3.0', '1.2.9')).toBe(true);
    expect(isNewerVersion('v0.2.0', '0.1.10')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.0', '1.2.0-beta.1')).toBe(true);
    expect(isNewerVersion('1.2.0-beta.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('garbage', '1.0.0')).toBe(false);
  });

  it('turns a check into a state and offers only newer versions', () => {
    const available = afterCheck(INITIAL_UPDATER, '0.2.0', '0.1.0', 10);
    expect(available).toEqual({
      status: 'available',
      version: '0.2.0',
      percent: null,
      checkedAt: 10,
      error: null,
    });
    expect(afterCheck(INITIAL_UPDATER, '0.1.0', '0.1.0', 10).status).toBe('current');
    expect(afterCheck(INITIAL_UPDATER, null, '0.1.0', 10).status).toBe('current');
    const ready: UpdaterState = { ...available, status: 'ready', percent: 100 };
    expect(afterCheck(ready, '0.2.0', '0.1.0', 20)).toEqual({ ...ready, checkedAt: 20 });
    expect(offeredVersion(available)).toBe('0.2.0');
    expect(offeredVersion({ ...INITIAL_UPDATER, status: 'current' })).toBeNull();
  });

  it('keeps only an error code', () => {
    expect(updaterErrorCode(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('network');
    expect(updaterErrorCode(new Error('sha512 checksum mismatch'))).toBe('signature');
    expect(updaterErrorCode(new Error('HttpError: 404'))).toBe('not_found');
    expect(updaterErrorCode('weird')).toBe('unknown');
  });
});

type FakeBackend = UpdaterBackend & {
  downloads: number;
  installs: number;
  /** electron-updater's `error` event (a failed `quitAndInstall` only emits it). */
  emitError(error: Error): void;
};

function fakeBackend(version: string | null): FakeBackend {
  const listeners: Array<(info: { percent: number }) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const b: FakeBackend = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    downloads: 0,
    installs: 0,
    isUpdaterActive: () => true,
    checkForUpdates: async () => (version ? { updateInfo: { version } } : null),
    downloadUpdate: async () => {
      b.downloads += 1;
      for (const l of listeners) l({ percent: 50.4 });
      return [];
    },
    quitAndInstall: () => {
      b.installs += 1;
    },
    on: ((event: string, listener: (arg: never) => void) => {
      if (event === 'error') errorListeners.push(listener as (error: Error) => void);
      else listeners.push(listener as (info: { percent: number }) => void);
      return b;
    }) as UpdaterBackend['on'],
    emitError: (error) => {
      for (const l of errorListeners) l(error);
    },
  };
  return b;
}

describe('flow', () => {
  it('check → download → ready → install, publishing each step', async () => {
    const backend = fakeBackend('0.2.0');
    const published: UpdaterState[] = [];
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => 1_000,
      publish: (s) => published.push(s),
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => backend,
    });
    expect((await updater.check()).status).toBe('available');
    expect(backend.autoDownload).toBe(false);
    expect(backend.autoInstallOnAppQuit).toBe(true);
    const ready = await updater.download();
    expect(ready).toMatchObject({ status: 'ready', version: '0.2.0', percent: 100 });
    expect(published.map((s) => s.status)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'ready',
    ]);
    expect(published[3]?.percent).toBe(50);
    await updater.install();
    await new Promise((resolve) => setImmediate(resolve));
    expect(backend.installs).toBe(1);
    updater.dispose();
  });

  it('an install that does not quit says so and leaves the app as it was', async () => {
    // electron-updater's quitAndInstall with no installer (AppImage moved, elevate.exe
    // missing): no `app.quit()`, only an `error`. Nothing marks the app as quitting here (the
    // bootstrap's `before-quit` does, and it never ran), so the X keeps hiding the windows.
    const backend = fakeBackend('0.2.0');
    backend.quitAndInstall = () => {
      backend.installs += 1;
      backend.emitError(new Error('ENOENT: no such file or directory, spawn elevate.exe'));
    };
    const published: UpdaterState[] = [];
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => 2_000,
      publish: (s) => published.push(s),
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => backend,
    });
    await updater.check();
    await updater.download();
    await updater.install();
    await new Promise((resolve) => setImmediate(resolve));
    expect(backend.installs).toBe(1);
    expect(updater.state()).toMatchObject({ status: 'error', version: '0.2.0' });
    expect(offeredVersion(updater.state())).toBe('0.2.0');
    // An `error` outside an install (a failed background check) is not an install failure.
    backend.emitError(new Error('later'));
    expect(published.filter((s) => s.status === 'error')).toHaveLength(1);
    // «Actualizar a v0.2.0» again: the download is redone, then the install is retried.
    backend.quitAndInstall = () => {
      backend.installs += 1;
    };
    expect((await updater.download()).status).toBe('ready');
    await updater.install();
    await new Promise((resolve) => setImmediate(resolve));
    expect(backend.installs).toBe(2);
    updater.dispose();
  });

  it('check-only systems open the download page instead', async () => {
    let opened = 0;
    const backend = fakeBackend('0.2.0');
    const updater = createUpdater({
      mode: 'check-only',
      currentVersion: '0.1.0',
      now: () => 1,
      publish: () => undefined,
      openDownloadPage: () => {
        opened += 1;
      },
      log: () => undefined,
      loadBackend: async () => backend,
    });
    expect((await updater.check()).status).toBe('available');
    await updater.download();
    await updater.install();
    expect(opened).toBe(2);
    expect(backend.downloads).toBe(0);
    expect(backend.installs).toBe(0);
    expect(backend.autoInstallOnAppQuit).toBe(false);
  });

  it('dev runs are unsupported and never load electron-updater', async () => {
    let loads = 0;
    const published: UpdaterState[] = [];
    const updater = createUpdater({
      mode: 'unsupported',
      currentVersion: '0.1.0',
      now: () => 1,
      publish: (s) => published.push(s),
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => {
        loads += 1;
        return fakeBackend(null);
      },
    });
    updater.start();
    expect(published.at(-1)?.status).toBe('unsupported');
    expect((await updater.check()).status).toBe('unsupported');
    expect(loads).toBe(0);
  });

  it('a failed check says why and keeps nothing else', async () => {
    const backend = fakeBackend('0.2.0');
    backend.checkForUpdates = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => 5,
      publish: () => undefined,
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => backend,
    });
    expect(await updater.check()).toEqual({
      status: 'error',
      version: null,
      percent: null,
      checkedAt: 5,
      error: 'network',
    });
  });

  it('a downloaded update stays ready through an offline periodic check', async () => {
    const backend = fakeBackend('0.2.0');
    let now = 1_000;
    const published: UpdaterState[] = [];
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => now,
      publish: (s) => published.push(s),
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => backend,
    });
    await updater.check();
    expect((await updater.download()).status).toBe('ready');
    published.length = 0;
    // Offline: the check fails, the files are still in electron-updater's cache.
    backend.checkForUpdates = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    now = 2_000;
    expect(await updater.check()).toEqual({
      status: 'ready',
      version: '0.2.0',
      percent: 100,
      checkedAt: 2_000,
      error: 'network',
    });
    // Never flickered through `checking` nor `error`.
    expect(published.map((s) => s.status)).toEqual(['ready']);
    // «Reiniciar para actualizar» installs without another download.
    await updater.install();
    await new Promise((resolve) => setImmediate(resolve));
    expect(backend.installs).toBe(1);
    expect(backend.downloads).toBe(1);
    // Back online: the same version stays ready and the recorded code goes away.
    backend.checkForUpdates = async () => ({ updateInfo: { version: '0.2.0' } });
    now = 3_000;
    expect(await updater.check()).toMatchObject({ status: 'ready', checkedAt: 3_000, error: null });
    updater.dispose();
  });

  it('an offered version stays available through a failed check', async () => {
    const backend = fakeBackend('0.2.0');
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => 7,
      publish: () => undefined,
      openDownloadPage: () => undefined,
      log: () => undefined,
      loadBackend: async () => backend,
    });
    expect((await updater.check()).status).toBe('available');
    backend.checkForUpdates = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    expect(await updater.check()).toMatchObject({
      status: 'available',
      version: '0.2.0',
      error: 'network',
    });
    updater.dispose();
  });
});
