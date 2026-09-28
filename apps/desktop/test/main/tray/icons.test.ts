import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRAY_ICON_DIR,
  TRAY_ICON_SIZES,
  trayIconFileName,
  trayIconSet,
  trayIconVariant,
} from '../../../src/main/tray/icons';

const ICONS = resolve(__dirname, '../../../resources', ...TRAY_ICON_DIR);

describe('tray icon files', () => {
  it('are all generated at every size (npm run gen:tray-icons)', () => {
    for (const spec of trayIconSet()) {
      for (const size of TRAY_ICON_SIZES) {
        const file = trayIconFileName(spec, size.suffix);
        expect(existsSync(join(ICONS, file)), file).toBe(true);
      }
    }
  });

  it('use Electron scale suffixes and the macOS «Template» name', () => {
    expect(TRAY_ICON_SIZES.map((s) => [s.px, s.scale])).toEqual([
      [16, 1],
      [20, 1.25],
      [24, 1.5],
      [32, 2],
    ]);
    expect(trayIconFileName({ key: 'idle', camera: false, variant: 'template' }, '@2x')).toBe(
      'tray-idleTemplate@2x.png',
    );
    expect(trayIconFileName({ key: 'study', camera: true, variant: 'dark' })).toBe(
      'tray-study-cam-dark.png',
    );
  });
});

describe('tray icon variant', () => {
  const surface = { darkSystemUi: true, darkApp: false, desktop: null };

  it('follows the taskbar on Windows', () => {
    expect(trayIconVariant('win32', 'idle', surface)).toBe('dark');
    expect(trayIconVariant('win32', 'idle', { ...surface, darkSystemUi: false })).toBe('light');
  });

  it('uses a template image for the idle icon on macOS', () => {
    expect(trayIconVariant('darwin', 'idle', surface)).toBe('template');
    expect(trayIconVariant('darwin', 'strict', { ...surface, darkApp: true })).toBe('dark');
  });

  it('assumes a dark panel on GNOME-based desktops', () => {
    expect(trayIconVariant('linux', 'idle', { ...surface, desktop: 'ubuntu:GNOME' })).toBe('dark');
    expect(trayIconVariant('linux', 'idle', { ...surface, desktop: 'KDE' })).toBe('light');
    expect(trayIconVariant('linux', 'idle', { ...surface, desktop: 'KDE', darkApp: true })).toBe(
      'dark',
    );
  });
});
