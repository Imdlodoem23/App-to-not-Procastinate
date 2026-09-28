import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINES, isEngine, manifestFor } from '../../manifest.mjs';

const source = JSON.parse(
  readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('per-engine manifests', () => {
  it('Chromium runs a split incognito instance: its own pages load in incognito tabs', () => {
    expect(manifestFor(source, 'chromium')['incognito']).toBe('split');
  });

  it('Firefox keeps spanning (it would treat split as not_allowed in private windows)', () => {
    expect(manifestFor(source, 'firefox')['incognito']).toBe('spanning');
  });

  it('differ only in incognito and leave the source untouched', () => {
    const before = structuredClone(source);
    for (const engine of ENGINES) {
      const { incognito: _incognito, ...rest } = manifestFor(source, engine);
      const { incognito: _source, ...base } = source;
      expect(rest).toEqual(base);
    }
    expect(source).toEqual(before);
    // The pinned Chromium id and the Firefox id stay in both.
    expect(manifestFor(source, 'firefox')['key']).toBe(source['key']);
  });

  it('knows only the two engines', () => {
    expect(ENGINES.filter(isEngine)).toEqual(['chromium', 'firefox']);
    expect(isEngine('safari')).toBe(false);
    expect(isEngine(undefined)).toBe(false);
  });
});
