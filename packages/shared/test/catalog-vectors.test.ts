import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CatalogPlatform } from '../src/catalog';
import {
  expandDomainVariants,
  findServiceByDomain,
  isProtectedProcessName,
  isValidDomain,
  isValidProcessName,
  matchesHostPattern,
  processNameKey,
} from '../src/catalog';
import {
  domainTargetKey,
  findAllowDistraction,
  processTargetKey,
  textFieldIssue,
} from '../src/guardian-api';

// ---------------------------------------------------------------------------------------
// Shared catalog and validation vectors (also run by the Go guardian)
// ---------------------------------------------------------------------------------------

interface Vector {
  name: string;
  fn: string;
  args: unknown[];
  expect: unknown;
}

const file = JSON.parse(
  readFileSync(new URL('./fixtures/catalog-vectors.json', import.meta.url), 'utf8'),
) as { formatVersion: number; vectors: Vector[] };

type Entries = Parameters<typeof findAllowDistraction>[0];
type Paths = Parameters<typeof findAllowDistraction>[1];

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  isValidDomain: (a) => isValidDomain(a[0] as string),
  expandDomainVariants: (a) => expandDomainVariants(a[0] as string),
  isValidProcessName: (a) => isValidProcessName(a[0] as string),
  isProtectedProcessName: (a) => isProtectedProcessName(a[0] as string),
  processNameKey: (a) => processNameKey(a[0] as string, a[1] as CatalogPlatform),
  findServiceByDomain: (a) => findServiceByDomain(a[0] as string)?.id ?? null,
  matchesHostPattern: (a) => matchesHostPattern(a[0] as string, a[1] as string),
  domainTargetKey: (a) => domainTargetKey(a[0] as string),
  processTargetKey: (a) => processTargetKey(a[0] as string, a[1] as CatalogPlatform),
  textFieldIssue: (a) =>
    textFieldIssue(a[0] as 'reason' | 'task' | 'scheduleName' | 'phrase', a[1] as string),
  findAllowDistraction: (a) =>
    findAllowDistraction(a[0] as Entries, a[1] as Paths, a[2] as CatalogPlatform | undefined),
};

describe('catalog and validation parity vectors', () => {
  it('have a runner for every function and cover each one', () => {
    expect(file.formatVersion).toBe(1);
    const used = new Set(file.vectors.map((v) => v.fn));
    for (const fn of used) expect(FUNCTIONS, `runner for ${fn}`).toHaveProperty(fn);
    expect([...used].sort()).toEqual(Object.keys(FUNCTIONS).sort());
    expect(new Set(file.vectors.map((v) => v.name)).size).toBe(file.vectors.length);
  });

  describe.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_, v) => {
    it('returns the expected value', () => {
      expect(FUNCTIONS[v.fn]?.(v.args)).toEqual(v.expect);
    });
  });
});
