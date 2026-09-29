/**
 * The installers must carry the offline focus sounds (PROMPT §9) and the Study Mode models, and
 * the app must read them where electron-builder puts them. These tests tie together
 * electron-builder.yml (`extraResources`), src/main/app/paths.ts and the files on disk;
 * scripts/check-packaged-resources.mjs then checks the real unpacked builds in the release
 * workflow.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODELS_DIR,
  SOUNDS_DIR,
  resolveAppPaths,
  soundFilePath,
  type AppPathsInput,
} from '../../../src/main/app/paths';
import { SOUND_FILES, SOUND_IDS } from '../../../src/shared/prefs';

const DESKTOP = resolve(__dirname, '../../..');
const RESOURCES_PATH = '/opt/Céntrate/resources';

// electron-builder reads its config with js-yaml (a dependency of app-builder-lib), so this
// test parses it with the same library rather than adding another.
const { load: loadYaml } = createRequire(import.meta.url)('js-yaml') as {
  load: (text: string) => unknown;
};

interface ExtraResource {
  from: string;
  to: string;
  filter: string[];
}

function extraResources(): ExtraResource[] {
  const config = loadYaml(readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8')) as {
    extraResources?: unknown;
  };
  expect(Array.isArray(config.extraResources)).toBe(true);
  return (config.extraResources as Record<string, unknown>[]).map((entry) => ({
    from: String(entry['from']),
    to: String(entry['to'] ?? entry['from']),
    filter: Array.isArray(entry['filter']) ? entry['filter'].map(String) : ['**/*'],
  }));
}

function entryFor(to: string): ExtraResource {
  const matches = extraResources().filter((entry) => entry.to === to);
  expect(matches, `extraResources entries with "to: ${to}"`).toHaveLength(1);
  return matches[0] as ExtraResource;
}

/** The glob subset the filters use (`*`, `**`, `?`), like minimatch with `dot: true`. */
function selects(entry: ExtraResource, relPath: string): boolean {
  return entry.filter.some((pattern) => {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i] as string;
      if (c === '*' && pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^$()|\\{}[\]!]/g, '\\$&');
    }
    return new RegExp(`^${re}$`).test(relPath);
  });
}

const base: Omit<AppPathsInput, 'packaged'> = {
  platform: 'linux',
  env: {},
  mainDir: join(DESKTOP, 'out', 'main'),
  resourcesPath: RESOURCES_PATH,
  userDataDir: '/home/u/.config/Céntrate',
  sysDirOverride: null,
};
const packaged = resolveAppPaths({ ...base, packaged: true });
const unpackaged = resolveAppPaths({ ...base, packaged: false });

describe('focus sounds in the installers', () => {
  const entry = entryFor(SOUNDS_DIR);

  it('copies resources/sounds to <resources>/sounds', () => {
    expect(entry.from).toBe('resources/sounds');
    expect(packaged.soundsDir).toBe(join(RESOURCES_PATH, entry.to));
    expect(unpackaged.soundsDir).toBe(join(DESKTOP, 'resources', 'sounds'));
  });

  it('resolves every sound id to a file that is packaged where the app reads it', () => {
    for (const id of SOUND_IDS) {
      const file = SOUND_FILES[id];
      expect(selects(entry, file), `${file} passes the filter`).toBe(true);
      expect(soundFilePath(packaged, id)).toBe(join(RESOURCES_PATH, 'sounds', file));
      const dev = soundFilePath(unpackaged, id);
      expect(dev).toBe(join(DESKTOP, 'resources', 'sounds', file));
      expect(existsSync(dev), dev).toBe(true);
    }
  });

  it('ships every loop in the folder and nothing else', () => {
    const inFolder = readdirSync(join(DESKTOP, entry.from));
    const shipped = inFolder.filter((name) => selects(entry, name)).sort();
    expect(shipped).toEqual(Object.values(SOUND_FILES).sort());
    expect(selects(entry, 'README.md')).toBe(false);
  });
});

describe('Study Mode models in the installers', () => {
  const entry = entryFor(MODELS_DIR);
  const dir = join(DESKTOP, entry.from);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    models: { file: string }[];
    wasm: { dir: string; files: { file: string }[] };
  };

  it('copies resources/models to <resources>/models', () => {
    expect(entry.from).toBe('resources/models');
    expect(packaged.modelsDir).toBe(join(RESOURCES_PATH, entry.to));
    expect(unpackaged.modelsDir).toBe(join(DESKTOP, 'resources', 'models'));
  });

  it('packages the manifest and every committed model it lists', () => {
    expect(selects(entry, 'manifest.json')).toBe(true);
    expect(manifest.models.length).toBeGreaterThan(0);
    for (const { file } of manifest.models) {
      expect(selects(entry, file), `${file} passes the filter`).toBe(true);
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
  });

  it('packages the MediaPipe runtime once fetch-models has copied it', () => {
    for (const { file } of manifest.wasm.files) {
      expect(selects(entry, `${manifest.wasm.dir}/${file}`), file).toBe(true);
    }
    expect(selects(entry, '.gitignore')).toBe(false);
  });
});
