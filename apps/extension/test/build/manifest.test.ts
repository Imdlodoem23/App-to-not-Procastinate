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

  it('Chromium differs only in incognito; the source is left untouched', () => {
    const before = structuredClone(source);
    const { incognito: _incognito, ...rest } = manifestFor(source, 'chromium');
    const { incognito: _source, ...base } = source;
    expect(rest).toEqual(base);
    // The unpacked install keeps the key that pins the id the guardian embeds.
    expect(manifestFor(source, 'chromium')['key']).toBe(source['key']);
    for (const engine of ENGINES) manifestFor(source, engine, { store: true });
    expect(source).toEqual(before);
  });

  it('the store build drops only `key` (the Chrome Web Store and Edge Add-ons refuse it)', () => {
    const store = manifestFor(source, 'chromium', { store: true });
    expect(store).not.toHaveProperty('key');
    const { key: _key, ...keyed } = manifestFor(source, 'chromium');
    expect(store).toEqual(keyed);
  });

  it('Firefox drops the Chromium-only keys and keeps its own id', () => {
    const firefox = manifestFor(source, 'firefox');
    expect(firefox).not.toHaveProperty('key');
    expect(firefox).not.toHaveProperty('minimum_chrome_version');
    expect(firefox['browser_specific_settings']).toEqual(source['browser_specific_settings']);
    const { incognito: _i, key: _k, minimum_chrome_version: _m, ...base } = source;
    const { incognito: _fi, ...rest } = firefox;
    expect(rest).toEqual(base);
  });

  it('knows only the two engines', () => {
    expect(ENGINES.filter(isEngine)).toEqual(['chromium', 'firefox']);
    expect(isEngine('safari')).toBe(false);
    expect(isEngine(undefined)).toBe(false);
  });
});
