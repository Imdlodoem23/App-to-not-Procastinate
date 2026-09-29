// Signs the extension as "unlisted" on addons.mozilla.org so Firefox keeps it after a restart.
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (GitHub Secrets). Output: release/*.xpi
// Signs a copy of dist/ (built by package.mjs, with its version) with the Firefox manifest
// (manifest.mjs: incognito "spanning"; Firefox would treat Chromium's "split" as
// "not_allowed" and never run the extension in private windows).
//
// Supply chain and secrets: web-ext is an exact devDependency, so its whole tree is locked in
// package-lock.json (never `npx --yes`, which resolves it fresh from the registry). It runs
// from node_modules with this Node binary (no npx, no shell on any platform), and the AMO
// credentials reach it only through its environment (WEB_EXT_API_KEY / WEB_EXT_API_SECRET),
// never on the command line where other processes could read them.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifestFor } from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * web-ext's CLI entry in node_modules, walking up from `fromDir` like Node's module
 * resolution (web-ext's "exports" hides its package.json from require.resolve). Null when
 * it is not installed.
 * @param {string} fromDir
 * @returns {string | null}
 */
export function findWebExtBin(fromDir) {
  let dir = resolve(fromDir);
  for (;;) {
    const pkgPath = join(dir, 'node_modules', 'web-ext', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['web-ext'];
      if (typeof bin !== 'string') throw new Error(`${pkgPath} declares no web-ext bin`);
      return join(dirname(pkgPath), bin);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The web-ext arguments: no credentials (they go in the environment, signEnv), no config
 * files from the home or working directory, never waiting on stdin.
 * @param {string} sourceDir
 * @param {string} artifactsDir
 * @returns {string[]}
 */
export function signArgs(sourceDir, artifactsDir) {
  return [
    'sign',
    `--source-dir=${sourceDir}`,
    `--artifacts-dir=${artifactsDir}`,
    '--channel=unlisted',
    '--no-config-discovery',
    '--no-input',
  ];
}

/**
 * web-ext's environment: `baseEnv` (not modified) with the credentials as WEB_EXT_API_KEY /
 * WEB_EXT_API_SECRET and without the AMO_JWT_* copies, which web-ext does not need.
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{ issuer: string, secret: string }} credentials
 * @returns {Record<string, string | undefined>}
 */
export function signEnv(baseEnv, credentials) {
  const env = { ...baseEnv };
  delete env.AMO_JWT_ISSUER;
  delete env.AMO_JWT_SECRET;
  env.WEB_EXT_API_KEY = credentials.issuer;
  env.WEB_EXT_API_SECRET = credentials.secret;
  return env;
}

/**
 * The web-ext process: this Node binary running web-ext's bin, without a shell.
 * @param {{ bin: string, sourceDir: string, artifactsDir: string,
 *   env: Record<string, string | undefined>, credentials: { issuer: string, secret: string } }} input
 * @returns {import('./sign-firefox.d.mts').SignCommand}
 */
export function signCommand({ bin, sourceDir, artifactsDir, env, credentials }) {
  return {
    file: process.execPath,
    args: [bin, ...signArgs(sourceDir, artifactsDir)],
    options: { stdio: 'inherit', env: signEnv(env, credentials) },
  };
}

/**
 * Signs `<cwd>/dist` into `<cwd>/release/*.xpi`. 'skipped' without AMO credentials; throws
 * when they are set but web-ext is not installed or fails (a release must not silently ship
 * without its .xpi).
 * @param {import('./sign-firefox.d.mts').SignFirefoxOptions} [options]
 * @returns {'signed' | 'skipped'}
 */
export function signFirefox({
  cwd = process.cwd(),
  env = process.env,
  findBin = () => findWebExtBin(HERE),
  exec = execFileSync,
  log = console.log,
} = {}) {
  const issuer = env.AMO_JWT_ISSUER;
  const secret = env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    log('AMO credentials not set: skipping Firefox signing.');
    return 'skipped';
  }
  const webExt = findBin();
  if (!webExt) {
    throw new Error(
      'web-ext is not installed: run `npm ci` (apps/extension devDependencies pin its version).',
    );
  }
  // Under release/ (git-ignored), so a failed run leaves nothing in the working tree.
  const releaseDir = join(cwd, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const sourceDir = mkdtempSync(join(releaseDir, 'firefox-src-'));
  try {
    cpSync(join(cwd, 'dist'), sourceDir, { recursive: true });
    const manifestPath = join(sourceDir, 'manifest.json');
    const manifest = manifestFor(JSON.parse(readFileSync(manifestPath, 'utf8')), 'firefox');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const command = signCommand({
      bin: webExt,
      sourceDir,
      artifactsDir: releaseDir,
      env,
      credentials: { issuer, secret },
    });
    exec(command.file, command.args, command.options);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
  return 'signed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    signFirefox();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
