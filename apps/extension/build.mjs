// Builds the MV3 extension into dist/ with esbuild (one codebase for Chromium and Firefox).
// Usage: node build.mjs [--engine chromium|firefox]
//
// The files are the same for both engines; only the manifest differs (manifest.mjs:
// incognito "split" for Chromium, "spanning" for Firefox). dist/ is the Chromium build by
// default (the e2e suite, Centrate-extension.zip); `--engine firefox` builds dist/ for
// Firefox (about:debugging). sign-firefox.mjs derives the Firefox build from dist/ itself.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isEngine, manifestFor } from './manifest.mjs';

const { values } = parseArgs({ options: { engine: { type: 'string', default: 'chromium' } } });
if (!isEngine(values.engine)) {
  console.error(`Unknown --engine ${values.engine} (chromium or firefox)`);
  process.exit(2);
}
const engine = values.engine;

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Background: the service worker in Chromium and the event page in Firefox (manifest
// `background.service_worker` + `background.scripts`, both `background.js`). It bundles the
// shared catalog, normalizers and guardian client from @centrate/shared.
await build({
  entryPoints: { background: 'src/background/index.ts' },
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'firefox128'],
  outdir,
  logLevel: 'info',
});

// Pages: blocked.html, the popup and the guide (options). public/*.html load
// `<name>.js` as a module and `<name>.css`: each entry imports its stylesheet, which
// @imports packages/shared/src/design/tokens.css, so esbuild emits the bundled CSS next to
// it. Code shared by the pages goes to chunk-*.js (web-accessible with blocked.html in the
// manifest). No inline scripts anywhere (MV3 CSP).
await build({
  entryPoints: {
    blocked: 'src/pages/blocked/main.ts',
    popup: 'src/pages/popup/main.ts',
    options: 'src/pages/options/main.ts',
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunk-[hash]',
  target: ['chrome120', 'firefox128'],
  outdir,
  legalComments: 'eof',
  logLevel: 'info',
});

cpSync('public', outdir, { recursive: true });

const manifestPath = join(outdir, 'manifest.json');
const manifest = manifestFor(JSON.parse(readFileSync(manifestPath, 'utf8')), engine);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`dist/ built for ${engine} (incognito: ${String(manifest['incognito'])})`);
