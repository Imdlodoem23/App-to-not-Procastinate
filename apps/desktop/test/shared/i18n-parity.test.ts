/**
 * Every `i18n/` folder of the app (Phase 5 builders add their own: `windows/estadisticas/i18n`,
 * `src/main/updater/i18n`…) is found here without editing this file: each needs `es.ts` and
 * `en.ts`, and every `X_ES` table of `es.ts` needs an `X_EN` twin in `en.ts` with exactly the
 * same keys, of the same kind, and no empty strings. The typed half of the parity is each
 * `en.ts` declaring the `Widen<typeof X_ES>` type.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function i18nFolders(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === 'i18n') out.push(path);
    else if (entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      out.push(...i18nFolders(path));
  }
  return out;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** «a.b.c» of every leaf, with its kind (string, function, array). */
function leaves(value: unknown, prefix = ''): string[] {
  if (isTable(value)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [`${prefix}:${Array.isArray(value) ? 'array' : typeof value}`];
}

function blanks(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [prefix] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => blanks(item, `${prefix}[${i}]`));
  if (isTable(value)) {
    return Object.entries(value).flatMap(([k, v]) => blanks(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

interface Pair {
  name: string;
  es: unknown;
  en: unknown;
}

const folders = i18nFolders(SRC);
const pairs: Pair[] = [];
const missing: string[] = [];
for (const folder of folders) {
  const where = relative(SRC, folder);
  const files = readdirSync(folder);
  if (!files.includes('es.ts') || !files.includes('en.ts')) {
    missing.push(where);
    continue;
  }
  const es = (await import(join(folder, 'es.ts'))) as Record<string, unknown>;
  const en = (await import(join(folder, 'en.ts'))) as Record<string, unknown>;
  for (const [key, value] of Object.entries(es)) {
    if (!key.endsWith('_ES') || !isTable(value)) continue;
    pairs.push({ name: `${where}: ${key}`, es: value, en: en[key.replace(/_ES$/, '_EN')] });
  }
}

describe('every i18n folder is bilingual', () => {
  it('finds the known folders and each has es.ts and en.ts', () => {
    expect(folders.length).toBeGreaterThanOrEqual(10);
    expect(missing).toEqual([]);
  });

  it.each(pairs.map((p) => [p.name, p] as const))('%s: English mirrors Spanish', (_name, pair) => {
    expect(isTable(pair.en)).toBe(true);
    expect(leaves(pair.en).sort()).toEqual(leaves(pair.es).sort());
    expect(blanks(pair.es)).toEqual([]);
    expect(blanks(pair.en)).toEqual([]);
  });
});
