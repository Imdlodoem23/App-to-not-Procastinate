#!/usr/bin/env node
// Puts the offline vision assets of @centrate/study-ai in apps/desktop/resources/models/
// (DESIGN.md §5.1). Never runs inside the app: the app only reads the files this script wrote.
//
//   face_landmarker.task            MediaPipe Face Landmarker, float16 v1   (committed)
//   efficientdet_lite0_int8.tflite  EfficientDet-Lite0, int8 v1             (committed)
//   manifest.json                   mirror of MODEL_MANIFEST + WASM digests (committed)
//   mediapipe/vision_wasm_internal.{js,wasm}  SIMD runtime copied from node_modules
//                                   (@mediapipe/tasks-vision, pinned version; git-ignored)
//
// The two models weigh 8.4 MB together, under the 15 MB limit for committed binaries, so the
// app builds and works offline with no download. The WASM pair (12 MB) already comes pinned
// from npm, so it is copied, not committed. The pinned URLs, sizes and SHA-256 come from
// packages/study-ai/src/assets.ts, the same constants the app checks before loading a model.
//
// Usage (from the repo root):
//   npm run fetch-models -w packages/study-ai               download what is missing or wrong
//   npm run fetch-models -w packages/study-ai -- --from <dir>   copy the models from <dir>
//   npm run fetch-models -w packages/study-ai -- --check    verify only, write nothing
// Options:
//   --out <dir>   write to <dir> instead of apps/desktop/resources/models
//   --no-wasm     skip the WASM copy
//
// Every mode checks size and SHA-256, and writes atomically (temporary file, then rename).
// Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node ≥ 22.21).
//
// Exit code: 0 ok, 1 missing or wrong files, 2 usage error.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// The pinned constants live in TypeScript; Node ≥ 22.18 strips the types on import.
const assets = await import('../src/assets.ts').catch((error) => {
  console.error(
    `Cannot load packages/study-ai/src/assets.ts (Node ${process.versions.node}; ` +
      'TypeScript type stripping needs Node ≥ 22.18).',
  );
  throw error;
});
const {
  MEDIAPIPE_VERSION,
  MEDIAPIPE_WASM_DIGESTS,
  MEDIAPIPE_WASM_FILES,
  MEDIAPIPE_WASM_SUBDIR,
  MODELS_DIR,
  MODEL_MANIFEST,
} = assets;

const PACKAGE_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '../..');
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Manifest written next to the models; the desktop serves only the files it lists. */
export function buildManifest() {
  return {
    $comment:
      'Written by packages/study-ai/scripts/fetch-models.mjs from packages/study-ai/src/assets.ts. Do not edit by hand.',
    format: 'centrate-study-ai-models',
    version: 1,
    models: MODEL_MANIFEST.map((m) => ({ ...m })),
    wasm: {
      package: '@mediapipe/tasks-vision',
      version: MEDIAPIPE_VERSION,
      dir: MEDIAPIPE_WASM_SUBDIR,
      committed: false,
      files: MEDIAPIPE_WASM_FILES.map((file) => ({ file, ...MEDIAPIPE_WASM_DIGESTS[file] })),
    },
  };
}

export function manifestText() {
  return `${JSON.stringify(buildManifest(), null, 2)}\n`;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `null` when `bytes` match, otherwise what is wrong. */
export function mismatch(bytes, expected) {
  if (bytes.byteLength !== expected.bytes) {
    return `size ${bytes.byteLength} ≠ ${expected.bytes}`;
  }
  const hash = sha256(bytes);
  return hash === expected.sha256 ? null : `sha256 ${hash} ≠ ${expected.sha256}`;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function download(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const hint =
      proxy && process.env.NODE_USE_ENV_PROXY !== '1'
        ? ' (behind a proxy? run with NODE_USE_ENV_PROXY=1)'
        : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function wasmSourceDir() {
  // The package's `exports` hide package.json; its main bundle sits next to it.
  const require = createRequire(join(PACKAGE_DIR, 'package.json'));
  const root = dirname(require.resolve('@mediapipe/tasks-vision'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return { dir: join(root, 'wasm'), version: pkg.version };
}

function fail(problems, line) {
  problems.push(line);
  console.error(`  ✗ ${line}`);
}

/**
 * Runs the script. Returns the exit code instead of exiting, so tests can call it.
 * @param {string[]} argv
 */
export async function run(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        from: { type: 'string' },
        out: { type: 'string' },
        check: { type: 'boolean', default: false },
        'no-wasm': { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.check && args.from) {
    console.error('--check and --from cannot be combined');
    return 2;
  }

  const out = resolve(args.out ?? join(REPO_ROOT, MODELS_DIR));
  const show = (path) => relative(process.cwd(), path) || '.';
  const problems = [];
  console.log(`${args.check ? 'Checking' : 'Preparing'} ${show(out)}`);

  // Models
  for (const model of MODEL_MANIFEST) {
    const dest = join(out, model.file);
    const current = readIfExists(dest);
    if (current !== null && mismatch(current, model) === null) {
      console.log(`  ✓ ${model.file}`);
      continue;
    }
    if (args.check) {
      fail(problems, `${model.file}: ${current === null ? 'missing' : mismatch(current, model)}`);
      continue;
    }
    let bytes;
    let origin;
    try {
      if (args.from) {
        origin = join(resolve(args.from), model.file);
        bytes = readFileSync(origin);
      } else {
        origin = model.url;
        bytes = await download(model.url);
      }
    } catch (error) {
      fail(problems, `${model.file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const wrong = mismatch(bytes, model);
    if (wrong !== null) {
      fail(problems, `${model.file} from ${origin}: ${wrong}`);
      continue;
    }
    writeAtomic(dest, bytes);
    console.log(`  ↓ ${model.file} (${bytes.byteLength} B, sha256 ok)`);
  }

  // Manifest
  const manifestPath = join(out, 'manifest.json');
  const manifest = manifestText();
  if (readIfExists(manifestPath)?.toString('utf8') === manifest) {
    console.log('  ✓ manifest.json');
  } else if (args.check) {
    fail(problems, 'manifest.json: missing or out of date (run fetch-models)');
  } else {
    writeAtomic(manifestPath, manifest);
    console.log('  ↓ manifest.json');
  }

  // WASM runtime
  if (!args['no-wasm']) {
    let source;
    try {
      source = wasmSourceDir();
    } catch (error) {
      source = null;
      fail(problems, `@mediapipe/tasks-vision not installed (${String(error)})`);
    }
    if (source !== null && source.version !== MEDIAPIPE_VERSION) {
      fail(problems, `@mediapipe/tasks-vision ${source.version} ≠ pinned ${MEDIAPIPE_VERSION}`);
      source = null;
    }
    for (const file of MEDIAPIPE_WASM_FILES) {
      const expected = MEDIAPIPE_WASM_DIGESTS[file];
      const dest = join(out, MEDIAPIPE_WASM_SUBDIR, file);
      const current = readIfExists(dest);
      if (current !== null && mismatch(current, expected) === null) {
        console.log(`  ✓ ${MEDIAPIPE_WASM_SUBDIR}/${file}`);
        continue;
      }
      if (args.check && current !== null) {
        fail(problems, `${MEDIAPIPE_WASM_SUBDIR}/${file}: ${mismatch(current, expected)}`);
        continue;
      }
      if (source === null) continue;
      const bytes = readIfExists(join(source.dir, file));
      const wrong = bytes === null ? 'missing in node_modules' : mismatch(bytes, expected);
      if (wrong !== null) {
        fail(problems, `node_modules/@mediapipe/tasks-vision/wasm/${file}: ${wrong}`);
        continue;
      }
      if (args.check) {
        // Not copied yet: fine for a check (the copy is a build step), the source is verified.
        console.log(`  · ${MEDIAPIPE_WASM_SUBDIR}/${file} not copied (node_modules copy ok)`);
        continue;
      }
      writeAtomic(dest, bytes);
      console.log(`  ↓ ${MEDIAPIPE_WASM_SUBDIR}/${file} (${bytes.byteLength} B, sha256 ok)`);
    }
  }

  if (problems.length > 0) {
    console.error(`${problems.length} problem(s).`);
    return 1;
  }
  console.log('All vision assets verified.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await run(process.argv.slice(2));
}
