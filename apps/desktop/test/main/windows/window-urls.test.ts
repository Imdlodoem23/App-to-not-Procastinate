import { describe, expect, it } from 'vitest';
import {
  isTrustedFrameUrl,
  rendererQuery,
  rendererUrl,
  type RendererSource,
} from '../../../src/main/windows/window-urls';

const FILE: RendererSource = {
  kind: 'file',
  path: '/opt/Céntrate/resources/app.asar/out/renderer/index.html',
};
const DEV: RendererSource = { kind: 'dev', url: 'http://localhost:5173/' };

describe('renderer URLs', () => {
  it('carries the window kind and, in the harness, the state', () => {
    expect(rendererQuery('main', null)).toEqual({ window: 'main' });
    expect(rendererQuery('detail', 'bloqueos')).toEqual({ window: 'detail', state: 'bloqueos' });
    expect(rendererQuery('main', 'idle', true)).toEqual({
      window: 'main',
      state: 'idle',
      'neutral-service-icons': '1',
    });
    expect(rendererUrl(DEV, { window: 'main', state: 'idle' })).toBe(
      'http://localhost:5173/?window=main&state=idle',
    );
    expect(rendererUrl(FILE, { window: 'main' })).toBe(
      'file:///opt/C%C3%A9ntrate/resources/app.asar/out/renderer/index.html?window=main',
    );
  });
});

describe('trusted sender frames', () => {
  it('accepts our document whatever the query', () => {
    const url =
      'file:///opt/C%C3%A9ntrate/resources/app.asar/out/renderer/index.html?window=detail#x';
    expect(isTrustedFrameUrl(url, FILE, 'linux')).toBe(true);
  });

  it('refuses other files, other schemes and garbage', () => {
    expect(isTrustedFrameUrl('file:///tmp/evil.html?window=main', FILE, 'linux')).toBe(false);
    expect(isTrustedFrameUrl('https://example.com/index.html', FILE, 'linux')).toBe(false);
    expect(isTrustedFrameUrl('about:blank', FILE, 'linux')).toBe(false);
    expect(isTrustedFrameUrl('not a url', FILE, 'linux')).toBe(false);
    expect(isTrustedFrameUrl(null, FILE, 'linux')).toBe(false);
  });

  it('compares Windows paths without case', () => {
    const win: RendererSource = {
      kind: 'file',
      path: 'C:\\Program Files\\Céntrate\\resources\\app.asar\\out\\renderer\\index.html',
    };
    // pathToFileURL on a POSIX host keeps backslashes; build the frame URL the same way.
    const expected = rendererUrl(win, { window: 'main' });
    expect(isTrustedFrameUrl(expected.toUpperCase().replace('FILE:', 'file:'), win, 'win32')).toBe(
      true,
    );
    expect(isTrustedFrameUrl(expected.toUpperCase().replace('FILE:', 'file:'), win, 'linux')).toBe(
      false,
    );
  });

  it('accepts only the dev server origin and its index', () => {
    expect(isTrustedFrameUrl('http://localhost:5173/?window=main', DEV, 'linux')).toBe(true);
    expect(isTrustedFrameUrl('http://localhost:5173/index.html?window=main', DEV, 'linux')).toBe(
      true,
    );
    expect(isTrustedFrameUrl('http://localhost:5174/?window=main', DEV, 'linux')).toBe(false);
    expect(isTrustedFrameUrl('http://localhost:5173/other.html', DEV, 'linux')).toBe(false);
  });
});
