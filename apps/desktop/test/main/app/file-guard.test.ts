import { describe, expect, it } from 'vitest';
import { isAllowedFileRequest } from '../../../src/main/app/file-guard';

const POSIX_DIR = '/opt/Centrate/resources/app.asar/out/renderer';
const WIN_DIR = 'C:\\Program Files\\Centrate\\resources\\app.asar\\out\\renderer';

describe('isAllowedFileRequest', () => {
  it('lets the renderer load its own document and assets', () => {
    const base = `file://${POSIX_DIR}`;
    expect(
      isAllowedFileRequest(`${base}/index.html?window=main&state=idle`, POSIX_DIR, 'linux'),
    ).toBe(true);
    expect(isAllowedFileRequest(`${base}/assets/index-C2gaikTk.css`, POSIX_DIR, 'linux')).toBe(
      true,
    );
    expect(isAllowedFileRequest(`${base}/`, POSIX_DIR, 'linux')).toBe(true);
    expect(
      isAllowedFileRequest(`file://localhost${POSIX_DIR}/index.html`, POSIX_DIR, 'darwin'),
    ).toBe(true);
  });

  it('refuses client.json and every other file outside the renderer folder', () => {
    for (const url of [
      'file:///var/lib/centrate/client.json',
      'file:///etc/hostname',
      'file://localhost/etc/hostname',
      `file://${POSIX_DIR}/../../../../client.json`,
      `file://${POSIX_DIR}/%2e%2e/%2e%2e/secret`,
      `file://${POSIX_DIR}-evil/index.html`,
      'file:///opt/Centrate/resources/app.asar/out/renderer',
      'file://evil-host/share/x',
      `file://${POSIX_DIR}/a%2F..%2F..%2Fx`,
    ]) {
      const allowed = isAllowedFileRequest(url, POSIX_DIR, 'linux');
      expect(allowed, url).toBe(url === 'file:///opt/Centrate/resources/app.asar/out/renderer');
    }
  });

  it('handles Windows paths: drive letters, case, UNC and encoded separators', () => {
    const base = 'file:///C:/Program%20Files/Centrate/resources/app.asar/out/renderer';
    expect(isAllowedFileRequest(`${base}/index.html?window=detail`, WIN_DIR, 'win32')).toBe(true);
    expect(isAllowedFileRequest(`${base.replace('C:', 'c:')}/assets/a.js`, WIN_DIR, 'win32')).toBe(
      true,
    );
    expect(
      isAllowedFileRequest('file:///C:/ProgramData/Centrate/client.json', WIN_DIR, 'win32'),
    ).toBe(false);
    expect(isAllowedFileRequest(`${base}/..%5C..%5Cclient.json`, WIN_DIR, 'win32')).toBe(false);
    expect(isAllowedFileRequest('file://server/share/renderer/index.html', WIN_DIR, 'win32')).toBe(
      false,
    );
    expect(isAllowedFileRequest('file:///D:/out/renderer/index.html', WIN_DIR, 'win32')).toBe(
      false,
    );
  });

  it('refuses every file: URL when the renderer comes from the dev server', () => {
    expect(isAllowedFileRequest(`file://${POSIX_DIR}/index.html`, null, 'linux')).toBe(false);
  });

  it('leaves other schemes to the CSP, refuses what does not parse', () => {
    expect(isAllowedFileRequest('http://localhost:5173/src/main.tsx', POSIX_DIR, 'linux')).toBe(
      true,
    );
    expect(
      isAllowedFileRequest('devtools://devtools/bundled/devtools_app.html', null, 'linux'),
    ).toBe(true);
    expect(isAllowedFileRequest('data:image/png;base64,AAAA', POSIX_DIR, 'linux')).toBe(true);
    expect(isAllowedFileRequest('not a url', POSIX_DIR, 'linux')).toBe(false);
  });
});
