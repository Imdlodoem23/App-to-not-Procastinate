import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clientJsonPath,
  createClientJsonSource,
  defaultSysDir,
  parseClientJson,
  resolveSysDir,
} from '../../../src/main/guardian/client-json';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-clientjson-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function body(token: string, port = 47600): string {
  return JSON.stringify({
    v: 1,
    port,
    token,
    guardianVersion: '0.1.0',
    pid: 4312,
    issuedAt: '2026-09-28T15:00:00.000Z',
  });
}

describe('system directory', () => {
  it('uses the per-OS default', () => {
    expect(defaultSysDir('win32', { ProgramData: 'D:\\PD' })).toBe('D:\\PD\\Centrate');
    expect(defaultSysDir('win32', {})).toBe('C:\\ProgramData\\Centrate');
    expect(defaultSysDir('darwin')).toBe('/Library/Application Support/Centrate');
    expect(defaultSysDir('linux')).toBe('/var/lib/centrate');
    expect(clientJsonPath('C:\\ProgramData\\Centrate', 'win32')).toBe(
      'C:\\ProgramData\\Centrate\\client.json',
    );
  });

  it('honours CENTRATE_DATA_DIR only when unpackaged and absolute', () => {
    const env = { CENTRATE_DATA_DIR: '/tmp/guardian-test' };
    expect(resolveSysDir({ platform: 'linux', packaged: false, env })).toBe('/tmp/guardian-test');
    expect(resolveSysDir({ platform: 'linux', packaged: true, env })).toBe('/var/lib/centrate');
    expect(
      resolveSysDir({ platform: 'linux', packaged: false, env: { CENTRATE_DATA_DIR: 'rel/dir' } }),
    ).toBe('/var/lib/centrate');
  });
});

describe('client.json', () => {
  it('parses the guardian file and rejects bad tokens', () => {
    expect(parseClientJson(body('cta_abcdefghijkl'))).toMatchObject({ port: 47600, token: 'cta_abcdefghijkl' });
    expect(parseClientJson(body('cte_abcdefghijkl'))).toBeNull();
    expect(parseClientJson(body('cta_abcdefghijkl', 0))).toBeNull();
    expect(parseClientJson('{')).toBeNull();
    expect(parseClientJson(JSON.stringify({ v: 2, token: 'cta_abcdefghijkl' }))).toBeNull();
  });

  it('reports a missing file as «not installed»', () => {
    const source = createClientJsonSource(join(tempDir(), 'client.json'));
    expect(source.missing()).toBe(true);
    expect(source.token()).toBeNull();
    expect(source.port()).toBe(47600);
  });

  it('re-reads a rotated token (guardian restart) and follows the port', () => {
    const dir = tempDir();
    const path = join(dir, 'client.json');
    writeFileSync(path, body('cta_firsttoken01'));
    const source = createClientJsonSource(path);
    expect(source.missing()).toBe(false);
    expect(source.token()).toBe('cta_firsttoken01');
    // Atomic replace (new inode) with a different token and port.
    const tmp = join(dir, 'client.json.tmp');
    writeFileSync(tmp, body('cta_secondtoken0002', 47601));
    unlinkSync(path);
    writeFileSync(path, body('cta_secondtoken0002', 47601));
    expect(source.token()).toBe('cta_secondtoken0002');
    expect(source.port()).toBe(47601);
    expect(source.guardianVersion()).toBe('0.1.0');
  });

  it('treats an unreadable file as installed without a token (401 → «Actualiza»)', () => {
    const dir = tempDir();
    const path = join(dir, 'client.json');
    writeFileSync(path, 'not json');
    const source = createClientJsonSource(path);
    expect(source.missing()).toBe(false);
    expect(source.token()).toBeNull();
  });
});
