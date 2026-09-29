/** The committed model files, their manifest, the licence record and fetch-models itself. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  MEDIAPIPE_WASM_DIGESTS,
  MEDIAPIPE_WASM_FILES,
  MODELS_DIR,
  MODEL_MANIFEST,
} from '../../src/assets';
import { manifestText, run, type ModelsManifest } from '../../scripts/fetch-models.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = resolve(PKG, '../..');
const MODELS = join(ROOT, MODELS_DIR);
const SCRIPT = join(PKG, 'scripts/fetch-models.mjs');

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-models-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('committed models', () => {
  it('match MODEL_MANIFEST byte for byte (size and SHA-256)', () => {
    for (const model of MODEL_MANIFEST) {
      const bytes = readFileSync(join(MODELS, model.file));
      expect(bytes.byteLength, model.file).toBe(model.bytes);
      expect(sha256(bytes), model.file).toBe(model.sha256);
    }
  });

  it('stay under the 15 MB budget for committed binaries', () => {
    const total = MODEL_MANIFEST.reduce((sum, m) => sum + m.bytes, 0);
    expect(total).toBeLessThan(15 * 1024 * 1024);
  });

  it('manifest.json mirrors MODEL_MANIFEST and the WASM digests', () => {
    const text = readFileSync(join(MODELS, 'manifest.json'), 'utf8');
    expect(text).toBe(manifestText());
    const manifest = JSON.parse(text) as ModelsManifest;
    expect(manifest.models).toEqual(MODEL_MANIFEST.map((m) => ({ ...m })));
    expect(manifest.wasm.files).toEqual(
      MEDIAPIPE_WASM_FILES.map((file) => ({ file, ...MEDIAPIPE_WASM_DIGESTS[file] })),
    );
  });

  it('the installed MediaPipe WASM is the pinned one', () => {
    const wasmDir = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
    for (const file of MEDIAPIPE_WASM_FILES) {
      const bytes = readFileSync(join(wasmDir, file));
      expect(bytes.byteLength, file).toBe(MEDIAPIPE_WASM_DIGESTS[file].bytes);
      expect(sha256(bytes), file).toBe(MEDIAPIPE_WASM_DIGESTS[file].sha256);
    }
  });

  it('ASSET-LICENSES.json records both models with the same digests', () => {
    const licenses = JSON.parse(readFileSync(join(ROOT, 'ASSET-LICENSES.json'), 'utf8')) as {
      assets: { sha256?: string; bytes?: number; license: string; files?: string[] }[];
    };
    for (const model of MODEL_MANIFEST) {
      const entry = licenses.assets.find((a) => a.sha256 === model.sha256);
      expect(entry, model.file).toBeDefined();
      expect(entry?.bytes).toBe(model.bytes);
      expect(entry?.license).toBe('Apache-2.0');
      expect(entry?.files).toContain(`${MODELS_DIR}/${model.file}`);
    }
  });
});

/** Hashing ~20 MB and a child process can be slow on a loaded CI runner. */
const SLOW = 30_000;

describe('fetch-models', () => {
  it(
    '--check passes on the repository (CLI exit code 0)',
    () => {
      const result = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
      expect(result.stderr).not.toMatch(/✗/);
      expect(result.status).toBe(0);
    },
    SLOW,
  );

  it(
    '--from copies verified models atomically and writes the manifest',
    async () => {
      const out = tempDir();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await run(['--from', MODELS, '--out', out, '--no-wasm'])).toBe(0);
      for (const model of MODEL_MANIFEST) {
        expect(sha256(readFileSync(join(out, model.file)))).toBe(model.sha256);
      }
      expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(manifestText());
      expect(await run(['--check', '--out', out, '--no-wasm'])).toBe(0);
      vi.restoreAllMocks();
    },
    SLOW,
  );

  it(
    'refuses a tampered source file and never writes it',
    async () => {
      const source = tempDir();
      const out = tempDir();
      const [face, objects] = MODEL_MANIFEST;
      copyFileSync(join(MODELS, objects!.file), join(source, objects!.file));
      const bytes = readFileSync(join(MODELS, face!.file));
      bytes[1000] = (bytes[1000]! + 1) & 0xff;
      writeFileSync(join(source, face!.file), bytes);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await run(['--from', source, '--out', out, '--no-wasm'])).toBe(1);
      expect(existsSync(join(out, face!.file))).toBe(false);
      expect(existsSync(join(out, objects!.file))).toBe(true);
      expect(await run(['--check', '--out', out, '--no-wasm'])).toBe(1);
      vi.restoreAllMocks();
    },
    SLOW,
  );

  it(
    'copies the pinned WASM pair next to the models',
    async () => {
      const out = tempDir();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await run(['--from', MODELS, '--out', out])).toBe(0);
      for (const file of MEDIAPIPE_WASM_FILES) {
        expect(sha256(readFileSync(join(out, 'mediapipe', file)))).toBe(
          MEDIAPIPE_WASM_DIGESTS[file].sha256,
        );
      }
      vi.restoreAllMocks();
    },
    SLOW,
  );

  it(
    'rejects unknown options (exit 2)',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await run(['--bogus'])).toBe(2);
      expect(await run(['--check', '--from', '/tmp'])).toBe(2);
      vi.restoreAllMocks();
    },
    SLOW,
  );
});
