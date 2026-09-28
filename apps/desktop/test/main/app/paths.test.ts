import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSysDir, resolveAppPaths } from '../../../src/main/app/paths';
import {
  desktopExecQuote,
  linuxAutostartEntry,
  linuxAutostartPath,
} from '../../../src/main/app/autostart-entry';

describe('guardian system directory', () => {
  it('is the per-OS location of client.json', () => {
    expect(defaultSysDir('win32', { ProgramData: 'D:\\ProgramData' })).toBe(
      'D:\\ProgramData\\Centrate',
    );
    expect(defaultSysDir('win32', {})).toBe('C:\\ProgramData\\Centrate');
    expect(defaultSysDir('darwin', {})).toBe('/Library/Application Support/Centrate');
    expect(defaultSysDir('linux', {})).toBe('/var/lib/centrate');
  });
});

describe('app paths', () => {
  const base = {
    env: {},
    mainDir: '/repo/apps/desktop/out/main',
    resourcesPath: '/opt/Céntrate/resources',
    userDataDir: '/home/u/.config/Céntrate',
    sysDirOverride: null,
  };

  it('resolves resources next to the build when unpackaged', () => {
    const paths = resolveAppPaths({ ...base, platform: 'linux', packaged: false });
    expect(paths.trayIconsDir).toBe(join('/repo/apps/desktop/resources', 'assets', 'tray'));
    expect(paths.guardianBinary).toBe('/repo/apps/desktop/resources/guardian/centrate-guardian');
    expect(paths.preload).toBe('/repo/apps/desktop/out/preload/index.js');
    expect(paths.rendererHtml).toBe('/repo/apps/desktop/out/renderer/index.html');
    expect(paths.sysDir).toBe('/var/lib/centrate');
  });

  it('resolves resources from process.resourcesPath when packaged', () => {
    const paths = resolveAppPaths({ ...base, platform: 'linux', packaged: true });
    expect(paths.trayIconsDir).toBe('/opt/Céntrate/resources/assets/tray');
    expect(paths.guardianBinary).toBe('/opt/Céntrate/resources/guardian/centrate-guardian');
  });

  it('adds .exe on Windows and honours the sys dir override', () => {
    const paths = resolveAppPaths({
      ...base,
      platform: 'win32',
      packaged: true,
      sysDirOverride: '/tmp/sys',
    });
    expect(paths.guardianBinary.endsWith('centrate-guardian.exe')).toBe(true);
    expect(paths.sysDir).toBe('/tmp/sys');
  });
});

describe('Linux autostart entry', () => {
  it('lives in the XDG autostart folder', () => {
    expect(linuxAutostartPath({}, '/home/u')).toBe('/home/u/.config/autostart/centrate.desktop');
    expect(linuxAutostartPath({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe(
      '/x/autostart/centrate.desktop',
    );
  });

  it('starts the app hidden, with the executable quoted', () => {
    const entry = linuxAutostartEntry('/opt/Céntrate/centrate', 'Céntrate');
    expect(entry).toContain('Exec="/opt/Céntrate/centrate" --hidden');
    expect(entry).toContain('Name=Céntrate');
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(desktopExecQuote('/a "b"/$c`d\\e')).toBe('"/a \\"b\\"/\\$c\\`d\\\\e"');
  });
});
