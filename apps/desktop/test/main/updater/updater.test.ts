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

function fakeBackend(
  version: string | null,
): UpdaterBackend & { downloads: number; installs: number } {
  const listeners: Array<(info: { percent: number }) => void> = [];
  const b = {
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
    on: (_event: 'download-progress', listener: (info: { percent: number }) => void) => {
      listeners.push(listener);
      return b;
    },
  };
  return b;
}

describe('flow', () => {
  it('check → download → ready → install, publishing each step', async () => {
    const backend = fakeBackend('0.2.0');
    const published: UpdaterState[] = [];
    let prepared = 0;
    const updater = createUpdater({
      mode: 'full',
      currentVersion: '0.1.0',
      now: () => 1_000,
      publish: (s) => published.push(s),
      openDownloadPage: () => undefined,
      prepareQuit: () => {
        prepared += 1;
      },
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
    expect(prepared).toBe(1);
    expect(backend.installs).toBe(1);
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
      prepareQuit: () => undefined,
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
      prepareQuit: () => undefined,
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
      prepareQuit: () => undefined,
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
});
