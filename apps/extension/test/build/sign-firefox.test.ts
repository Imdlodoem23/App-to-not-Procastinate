import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec, SignCommand } from '../../sign-firefox.mjs';
import { findWebExtBin, signArgs, signCommand, signEnv, signFirefox } from '../../sign-firefox.mjs';

const ISSUER = 'user:12345:678';
const SECRET = 'amo-secret-value';
const credentials = { issuer: ISSUER, secret: SECRET };

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { devDependencies: Record<string, string> };
const sourceManifest = readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'centrate-sign-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeWebExt(dir: string, bin: unknown): void {
  const pkgDir = join(dir, 'node_modules', 'web-ext');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'web-ext', bin }));
}

function fakeBuild(dir: string): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'manifest.json'), sourceManifest);
  writeFileSync(join(dir, 'dist', 'background.js'), '// built');
}

describe('web-ext comes from the lockfile', () => {
  it('is an exact devDependency (its whole tree is then locked in package-lock.json)', () => {
    expect(packageJson.devDependencies['web-ext']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('finds the bin in node_modules walking up (npm workspaces hoist it to the root)', () => {
    fakeWebExt(root, { 'web-ext': 'bin/web-ext.js' });
    const nested = join(root, 'apps', 'extension');
    mkdirSync(nested, { recursive: true });
    expect(findWebExtBin(nested)).toBe(join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'));
  });

  it('accepts a string bin and prefers the closest install', () => {
    fakeWebExt(root, { 'web-ext': 'bin/outer.js' });
    const nested = join(root, 'apps', 'extension');
    fakeWebExt(nested, 'bin/inner.js');
    expect(findWebExtBin(nested)).toBe(join(nested, 'node_modules', 'web-ext', 'bin', 'inner.js'));
  });

  it('is null when web-ext is not installed, and rejects a package without a bin', () => {
    expect(findWebExtBin(root)).toBeNull();
    fakeWebExt(root, undefined);
    expect(() => findWebExtBin(root)).toThrow(/no web-ext bin/);
  });
});

describe('the web-ext process', () => {
  const command: SignCommand = signCommand({
    bin: '/repo/node_modules/web-ext/bin/web-ext.js',
    sourceDir: 'release/firefox-src-x',
    artifactsDir: 'release',
    env: { PATH: '/usr/bin', AMO_JWT_ISSUER: ISSUER, AMO_JWT_SECRET: SECRET },
    credentials,
  });

  it('runs the bin on this Node, without npx or a shell', () => {
    expect(command.file).toBe(process.execPath);
    expect(command.args[0]).toBe('/repo/node_modules/web-ext/bin/web-ext.js');
    expect(command.args.join(' ')).not.toMatch(/npx|--yes/);
    expect(command.options).not.toHaveProperty('shell');
  });

  it('never puts the credentials on the command line', () => {
    for (const arg of command.args) {
      expect(arg).not.toContain(SECRET);
      expect(arg).not.toContain(ISSUER);
      expect(arg).not.toMatch(/^--api-(key|secret)/);
    }
  });

  it('signs unlisted, ignores config files and never waits on stdin', () => {
    expect(signArgs('src dir', 'out')).toEqual([
      'sign',
      '--source-dir=src dir',
      '--artifacts-dir=out',
      '--channel=unlisted',
      '--no-config-discovery',
      '--no-input',
    ]);
  });

  it('passes the credentials through web-ext environment variables only', () => {
    const base = { PATH: '/usr/bin', AMO_JWT_ISSUER: ISSUER, AMO_JWT_SECRET: SECRET };
    const env = signEnv(base, credentials);
    expect(env).toEqual({ PATH: '/usr/bin', WEB_EXT_API_KEY: ISSUER, WEB_EXT_API_SECRET: SECRET });
    expect(base).toEqual({ PATH: '/usr/bin', AMO_JWT_ISSUER: ISSUER, AMO_JWT_SECRET: SECRET });
    expect(command.options.env).toEqual(env);
  });
});

describe('signFirefox', () => {
  const env = { PATH: '/usr/bin', AMO_JWT_ISSUER: ISSUER, AMO_JWT_SECRET: SECRET };

  it('skips without credentials (no web-ext, no files)', () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const result = signFirefox({
      cwd: root,
      env: { AMO_JWT_ISSUER: ISSUER },
      findBin: () => '/nowhere/web-ext.js',
      exec: (...args) => calls.push(args),
      log: (message) => logs.push(message),
    });
    expect(result).toBe('skipped');
    expect(calls).toEqual([]);
    expect(logs).toEqual(['AMO credentials not set: skipping Firefox signing.']);
    expect(existsSync(join(root, 'release'))).toBe(false);
  });

  it('fails when credentials are set but web-ext is missing', () => {
    fakeBuild(root);
    const calls: unknown[] = [];
    expect(() =>
      signFirefox({ cwd: root, env, findBin: () => null, exec: (...args) => calls.push(args) }),
    ).toThrow(/web-ext is not installed/);
    expect(calls).toEqual([]);
  });

  it('signs a Firefox-manifest copy of dist/ with the credentials in the environment', () => {
    fakeBuild(root);
    const seen: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    let copied: Record<string, unknown> = {};
    const exec: Exec = (file, args, options) => {
      seen.push({ file, args, env: options.env });
      const sourceDir = args.find((arg) => arg.startsWith('--source-dir='))!.slice(13);
      copied = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(existsSync(join(sourceDir, 'background.js'))).toBe(true);
    };
    const result = signFirefox({ cwd: root, env, findBin: () => '/bin/web-ext.js', exec });
    expect(result).toBe('signed');
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call!.file).toBe(process.execPath);
    expect(call!.args).toContain(`--artifacts-dir=${join(root, 'release')}`);
    expect(call!.args.some((arg) => arg.includes(SECRET))).toBe(false);
    expect(call!.env['WEB_EXT_API_SECRET']).toBe(SECRET);
    expect(call!.env['AMO_JWT_SECRET']).toBeUndefined();
    expect(copied['incognito']).toBe('spanning');
    // dist/ keeps Chromium's manifest; the temporary copy is gone.
    const dist = JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(dist['incognito']).toBe(JSON.parse(sourceManifest).incognito);
    expect(readdir(join(root, 'release'))).toEqual([]);
  });

  it('removes the temporary copy and rethrows when web-ext fails', () => {
    fakeBuild(root);
    const exec: Exec = () => {
      throw new Error('web-ext sign failed');
    };
    expect(() => signFirefox({ cwd: root, env, findBin: () => '/bin/web-ext.js', exec })).toThrow(
      'web-ext sign failed',
    );
    expect(readdir(join(root, 'release'))).toEqual([]);
  });
});

function readdir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
