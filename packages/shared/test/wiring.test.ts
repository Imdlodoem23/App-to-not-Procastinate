import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Wiring the design tokens depend on outside src/: the package exports that apps import the CSS
 * through, and the CI lint that rejects loose colors. Part of it lives in files this package
 * does not own (package.json, the root package.json). PENDING lists the checks still waiting
 * for those edits: a pending check must fail today, and once it passes it has to leave PENDING,
 * so it guards for good.
 */
const PENDING = new Set<string>([]);

function check(name: string, fn: () => void): void {
  if (!PENDING.has(name)) {
    it(name, fn);
    return;
  }
  it(`${name} (pending, see PENDING)`, () => {
    expect(fn, `"${name}" passes now: remove it from PENDING`).toThrow();
  });
}

const designDir = new URL('../src/design/', import.meta.url);
const require = createRequire(import.meta.url);
const readJson = (url: URL): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(url, 'utf8')) as { scripts?: Record<string, string> };

describe('package exports', () => {
  const cssFiles = readdirSync(designDir).filter((f) => f.endsWith('.css'));

  it('covers every design CSS file', () => {
    expect(cssFiles.sort()).toEqual(['tailwind-theme.css', 'tokens.css']);
  });

  for (const file of cssFiles) {
    // What `@import '@centrate/shared/design/<file>'` resolves to in Vite and Node.
    check(`exports ./design/${file}`, () => {
      const resolved = require.resolve(`@centrate/shared/design/${file}`);
      expect(realpathSync(resolved)).toBe(realpathSync(fileURLToPath(new URL(file, designDir))));
    });
  }

  it('tailwind-theme.css documents the package import path', () => {
    const css = readFileSync(new URL('tailwind-theme.css', designDir), 'utf8');
    expect(css).toContain("@import '@centrate/shared/design/tailwind-theme.css';");
  });
});

describe('CI color lint', () => {
  const rootPackage = new URL('../../../package.json', import.meta.url);
  const ci = new URL('../../../.github/workflows/ci.yml', import.meta.url);

  check('root lint runs scripts/lint-colors.mjs', () => {
    const scripts = readJson(rootPackage).scripts ?? {};
    expect(scripts['lint:tokens']).toMatch(/\bnode scripts\/lint-colors\.mjs\b/);
    expect(scripts['lint']).toMatch(/\bnpm run lint:tokens\b/);
  });

  it('CI runs the root lint', () => {
    expect(readFileSync(ci, 'utf8')).toMatch(/run: npm run lint\s*$/m);
  });
});
