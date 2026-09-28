/**
 * Static guards for the whole package (lead-owned). They encode the privacy and architecture
 * rules of DESIGN.md §3–4 so a builder cannot break them by accident.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEDIAPIPE_NETWORK_HOSTS } from '../src/assets';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Repo-style path relative to the package, with forward slashes. */
function rel(file: string): string {
  return relative(PKG, file).split(sep).join('/');
}

/** Source without comments, so documentation may mention banned names. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const srcFiles = walk(SRC);
const allFiles = [...srcFiles, ...walk(join(PKG, 'demo')), ...walk(join(PKG, 'scripts'))];

/** Files allowed to touch the browser/DOM or MediaPipe (reachable only from src/runtime.ts). */
const BROWSER_FILES = new Set([
  'src/runtime.ts',
  'src/perception/vision.ts',
  'src/perception/camera.ts',
  'src/runtime/session.ts',
  'src/runtime/calibration-session.ts',
  'src/runtime/analysis-host.ts',
]);
const isBrowserFile = (path: string): boolean =>
  BROWSER_FILES.has(path) || path.startsWith('src/perception/browser/');

/** Relative imports of a file, resolved to package-relative `.ts` paths. */
function relativeImports(file: string): string[] {
  const text = code(file);
  const specs = [
    ...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map((m) => m[1] as string);
  return specs.map((spec) => {
    const base = resolve(dirname(file), spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
      try {
        if (statSync(candidate).isFile()) return rel(candidate);
      } catch {
        // try the next candidate
      }
    }
    return rel(base);
  });
}

describe('privacy and platform guards', () => {
  it('never imports electron', () => {
    for (const file of allFiles) {
      expect(code(file), rel(file)).not.toMatch(
        /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/,
      );
    }
  });

  it('never uses requestAnimationFrame (it stops in hidden windows)', () => {
    for (const file of allFiles) {
      expect(code(file), rel(file)).not.toMatch(/requestAnimationFrame|requestVideoFrameCallback/);
    }
  });

  it('has no network, storage or image-export APIs', () => {
    const banned =
      /\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|toDataURL|toBlob|convertToBlob|createObjectURL)\b/;
    for (const file of srcFiles) expect(code(file), rel(file)).not.toMatch(banned);
  });

  it('fetches only in the vision loader (local model URLs)', () => {
    for (const file of srcFiles) {
      if (rel(file) === 'src/perception/vision.ts') continue;
      expect(code(file), rel(file)).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('reads pixels only in perception (the 32×24 luma thumbnail)', () => {
    for (const file of srcFiles) {
      if (rel(file).startsWith('src/perception/')) continue;
      expect(code(file), rel(file)).not.toMatch(/getImageData/);
    }
  });

  it('keeps randomness seeded and time injected outside the runtime', () => {
    for (const file of srcFiles) {
      const path = rel(file);
      expect(code(file), path).not.toMatch(/Math\.random\s*\(/);
      if (
        path.startsWith('src/runtime/') ||
        path.startsWith('src/perception/') ||
        path === 'src/util/time.ts'
      )
        continue;
      expect(code(file), path).not.toMatch(
        /Date\.now\s*\(|performance\.now\s*\(|new Date\s*\(\s*\)/,
      );
    }
  });

  it('imports MediaPipe values only lazily, only in the vision loader', () => {
    for (const file of srcFiles) {
      const text = code(file);
      const staticValueImport = /import\s+(?!type\b)[^'"]*from\s*['"]@mediapipe\/tasks-vision['"]/;
      expect(text, rel(file)).not.toMatch(staticValueImport);
      if (rel(file) !== 'src/perception/vision.ts') {
        expect(text, rel(file)).not.toMatch(/import\(\s*['"]@mediapipe\/tasks-vision['"]\s*\)/);
      }
    }
  });
});

describe('layering', () => {
  const LAYER: Record<string, number> = {
    types: 0,
    config: 0,
    util: 0,
    assets: 0,
    perception: 1,
    classifier: 2,
    calibration: 2,
    score: 3,
    state: 3,
    runtime: 4,
  };
  const layerOf = (path: string): number | undefined => {
    const m = /^src\/([^/.]+)/.exec(path);
    return m ? LAYER[m[1] as string] : undefined;
  };

  it('imports only from the same or a lower layer', () => {
    for (const file of srcFiles) {
      const from = rel(file);
      if (from === 'src/index.ts' || from === 'src/runtime.ts') continue;
      const own = layerOf(from);
      if (own === undefined) continue;
      for (const target of relativeImports(file)) {
        const other = layerOf(target);
        if (other === undefined) continue;
        expect(other <= own, `${from} → ${target}`).toBe(true);
      }
    }
  });

  it('the pure entry never reaches browser-only files', () => {
    const seen = new Set<string>();
    const queue = ['src/index.ts'];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      expect(isBrowserFile(path), `src/index.ts reaches ${path}`).toBe(false);
      for (const next of relativeImports(join(PKG, path))) queue.push(next);
    }
    for (const path of seen) {
      const text = code(join(PKG, path));
      expect(text, path).not.toMatch(
        /\b(document|window|navigator)\.|OffscreenCanvas|ImageCapture/,
      );
    }
  });
});

describe('MediaPipe bundle', () => {
  it('contains no network host besides the blocked usage logger', () => {
    const require = createRequire(import.meta.url);
    const main = require.resolve('@mediapipe/tasks-vision');
    const bundle = readFileSync(join(dirname(main), 'vision_bundle.mjs'), 'utf8');
    const hosts = new Set(
      [...bundle.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)].map((m) =>
        (m[1] as string).toLowerCase(),
      ),
    );
    expect([...hosts].sort()).toEqual([...MEDIAPIPE_NETWORK_HOSTS].sort());
  });
});
