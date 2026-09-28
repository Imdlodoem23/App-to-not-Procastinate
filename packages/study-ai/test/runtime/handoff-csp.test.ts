/**
 * The CSP HANDOFF §1.1 prescribes for the analysis window is the one the browser smoke test
 * runs the real pipeline under (demo/analysis.html, with `centrate-ai:` served by the loopback
 * demo server as 'self'). This keeps the two from drifting apart.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '../..');

type Policy = Record<string, string[]>;

function parse(csp: string): Policy {
  const policy: Policy = {};
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    policy[name] = [...new Set(sources)].sort();
  }
  return policy;
}

function handoffPolicy(): Policy {
  const handoff = readFileSync(join(PKG, 'HANDOFF.md'), 'utf8');
  const block = /CSP of `analysis\.html`[^\n]*\n\n```text\n([\s\S]*?)\n```/.exec(handoff);
  expect(block, 'HANDOFF §1.1 CSP block').not.toBeNull();
  return parse((block?.[1] ?? '').replace(/\s+/g, ' '));
}

function pagePolicy(): Policy {
  const page = readFileSync(join(PKG, 'demo/analysis.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page);
  expect(meta, 'demo/analysis.html CSP meta').not.toBeNull();
  return parse(meta?.[1] ?? '');
}

describe('analysis window CSP', () => {
  it('HANDOFF allows no network: connect-src is the asset scheme only', () => {
    const policy = handoffPolicy();
    expect(policy['default-src']).toEqual(["'none'"]);
    expect(policy['connect-src']).toEqual(['centrate-ai:']);
    expect(policy['img-src']).toEqual(["'none'"]);
    for (const sources of Object.values(policy)) {
      for (const source of sources) {
        expect(source).not.toMatch(/^(https?:|wss?:|\*|'unsafe-(eval|inline)')/);
      }
    }
  });

  it('the smoke-test page uses exactly the HANDOFF policy (centrate-ai: → self)', () => {
    const expected: Policy = {};
    for (const [name, sources] of Object.entries(handoffPolicy())) {
      expected[name] = [...new Set(sources.map((s) => (s === 'centrate-ai:' ? "'self'" : s)))].sort();
    }
    expect(pagePolicy()).toEqual(expected);
  });
});
