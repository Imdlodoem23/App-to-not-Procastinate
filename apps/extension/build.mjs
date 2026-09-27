// Builds the MV3 extension into dist/ with esbuild (one codebase for Chromium and Firefox).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: { background: 'src/background.ts' },
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'firefox128'],
  outdir,
  logLevel: 'info',
});

cpSync('public', outdir, { recursive: true });
