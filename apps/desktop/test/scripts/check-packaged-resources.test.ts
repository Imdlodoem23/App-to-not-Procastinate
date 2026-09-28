/**
 * scripts/check-packaged-resources.mjs, run on a small fake desktop folder and release tree
 * (the real one needs a full electron-builder run; the release workflow does that).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/check-packaged-resources.mjs');

const CONFIG = `extraResources:
  - from: resources/assets
    to: assets
    filter: ['**/*']
  - from: resources/sounds
    to: sounds
    filter: ['*.wav']
  - from: resources/models
    to: models
    filter: ['*.task', 'manifest.json', 'mediapipe/**']
  - from: resources/guardian
    to: guardian
`;

const MANIFEST = JSON.stringify({
  models: [{ file: 'face.task' }],
  wasm: { dir: 'mediapipe', files: [{ file: 'runtime.wasm' }] },
});

let root: string;

function write(rel: string, content: string): void {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function check(config = CONFIG): { status: number | null; out: string } {
  write('desktop/electron-builder.yml', config);
  const run = spawnSync(
    process.execPath,
    [SCRIPT, join(root, 'release'), '--desktop-dir', join(root, 'desktop')],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } },
  );
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** A source tree and a matching Linux unpacked build. */
function buildGood(resources = 'release/linux-unpacked/resources'): void {
  const files: Record<string, string> = {
    'assets/tray/idle.png': 'png',
    'sounds/lluvia.wav': 'rain-bytes',
    'sounds/lo-fi.wav': 'lofi-bytes',
    'models/manifest.json': MANIFEST,
    'models/face.task': 'model-bytes',
  };
  for (const [rel, content] of Object.entries(files)) {
    write(`desktop/resources/${rel}`, content);
    write(`${resources}/${rel}`, content);
  }
  // Never shipped: outside the filters, or skipped by electron-builder's copyDir.
  write('desktop/resources/sounds/README.md', 'docs');
  write('desktop/resources/models/.gitignore', '/mediapipe/');
  write('desktop/resources/assets/.gitkeep', '');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'centrate-pack-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-packaged-resources', () => {
  it('passes a complete build and warns about what is not there yet', () => {
    buildGood();
    const { status, out } = check();
    expect(status, out).toBe(0);
    expect(out).toContain('linux-unpacked/resources: 5/5 files, 2 sounds');
    expect(out).toContain('resources/guardian does not exist at packaging time');
    expect(out).toContain('models/mediapipe/runtime.wasm is not bundled');
  });

  it('checks the MediaPipe runtime when it was fetched before packaging', () => {
    buildGood();
    write('desktop/resources/models/mediapipe/runtime.wasm', 'wasm');
    expect(check().status).toBe(1);
    write('release/linux-unpacked/resources/models/mediapipe/runtime.wasm', 'wasm');
    expect(check().status).toBe(0);
  });

  it('fails when a sound is missing or differs from its source', () => {
    buildGood();
    rmSync(join(root, 'release/linux-unpacked/resources/sounds/lo-fi.wav'));
    const missing = check();
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('missing sounds/lo-fi.wav');

    write('release/linux-unpacked/resources/sounds/lo-fi.wav', 'truncated');
    const differs = check();
    expect(differs.status).toBe(1);
    expect(differs.out).toContain('sounds/lo-fi.wav is 9 bytes, expected 10');
  });

  it('fails when a model listed in the packaged manifest is missing', () => {
    buildGood();
    write(
      'release/linux-unpacked/resources/models/manifest.json',
      JSON.stringify({ models: [{ file: 'face.task' }, { file: 'objects.tflite' }] }),
    );
    const { status, out } = check();
    expect(status).toBe(1);
    expect(out).toContain('missing models/objects.tflite (listed in manifest.json)');
  });

  it('fails when the config stops packaging sounds or models', () => {
    buildGood();
    const { status, out } = check(
      CONFIG.replace(/ {2}- from: resources\/sounds[\s\S]*?\.wav'\]\n/, ''),
    );
    expect(status).toBe(1);
    expect(out).toContain('no extraResources entry with "to: sounds"');
  });

  it('finds the app inside a macOS build and fails with no build at all', () => {
    buildGood('release/mac-universal/Céntrate.app/Contents/Resources');
    expect(check().status).toBe(0);
    rmSync(join(root, 'release'), { recursive: true });
    const none = check();
    expect(none.status).toBe(1);
    expect(none.out).toContain('no unpacked build');
  });
});
