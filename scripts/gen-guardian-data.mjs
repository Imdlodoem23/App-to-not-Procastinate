// Generates the data the guardian embeds (docs/ARCHITECTURE.md §12):
//
//   packages/shared/src/catalog       catalogSnapshot()      -> guardian/internal/embedded/catalog.json
//   packages/shared/src/points.ts     rulesSnapshot()        -> guardian/internal/embedded/rules.json
//   packages/shared/src/guardian-api.ts apiContractSnapshot() -> guardian/internal/embedded/api.json
//
// A tiny entry is bundled in memory with esbuild and imported as a data: URL (no temp
// files). Each file is written as
//
//   {"data": {...}, "generatedBy": "scripts/gen-guardian-data.mjs", "sourceSha256": "<hex>"}
//
// with every object's keys sorted (UTF-16 code unit order, locale independent), 2-space
// indent, LF line endings and a trailing newline, so the output is byte-identical across
// runs and operating systems. `sourceSha256` is the SHA-256 of the compact form of `data`
// (`JSON.stringify` of the key-sorted value, UTF-8): exactly what Go's `json.Compact`
// yields from the indented `data` member, which is how the guardian verifies it.
//
// Usage: node scripts/gen-guardian-data.mjs [--check]
//   --check  write nothing; exit 1 if any file is missing or out of date (CI freshness).
//
// Never edit the generated files by hand: change packages/shared and run `npm run gen:guardian`.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const GENERATED_BY = 'scripts/gen-guardian-data.mjs';
const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'guardian', 'internal', 'embedded');

/** Output file name -> [module path from the repo root, exported snapshot function]. */
const SOURCES = {
  'catalog.json': ['./packages/shared/src/catalog/index.ts', 'catalogSnapshot'],
  'rules.json': ['./packages/shared/src/points.ts', 'rulesSnapshot'],
  'api.json': ['./packages/shared/src/guardian-api.ts', 'apiContractSnapshot'],
};

const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

/** Imports every snapshot function through one esbuild bundle built in memory. */
async function loadSnapshots() {
  // A TS re-export of a missing name is silently dropped (it could be a type), so the
  // loop below checks that each snapshot function really arrived.
  const lines = Object.values(SOURCES).map(
    ([modulePath, name]) => `export { ${name} } from ${JSON.stringify(modulePath)};`,
  );
  const result = await build({
    stdin: {
      contents: lines.join('\n'),
      resolveDir: root,
      sourcefile: 'gen-guardian-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    sourcemap: false,
    legalComments: 'none',
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`esbuild produced ${result.outputFiles.length} files, expected 1`);
  }
  const code = result.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const snapshots = {};
  for (const [file, [modulePath, name]] of Object.entries(SOURCES)) {
    const fn = mod[name];
    if (typeof fn !== 'function') {
      throw new Error(`${modulePath} does not export a function named ${name}`);
    }
    snapshots[file] = fn();
  }
  return snapshots;
}

/**
 * A deep copy with every object's keys sorted. Rejects anything that JSON cannot carry
 * losslessly, so a snapshot change can never silently drop or mangle a value.
 */
function canonical(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite number ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => canonical(item, `${path}[${i}]`));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${path}: not a plain object`);
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new Error(`${path}.${key}: undefined`);
      out[key] = canonical(item, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`${path}: unsupported ${typeof value}`);
}

/** The exact bytes of one generated file. */
function render(data, file) {
  const canonicalData = canonical(data, file);
  const sourceSha256 = createHash('sha256')
    .update(JSON.stringify(canonicalData), 'utf8')
    .digest('hex');
  const doc = canonical({ data: canonicalData, generatedBy: GENERATED_BY, sourceSha256 }, file);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function main() {
  const snapshots = await loadSnapshots();
  const stale = [];
  if (!args.check) mkdirSync(outDir, { recursive: true });
  for (const file of Object.keys(SOURCES)) {
    const path = join(outDir, file);
    const text = render(snapshots[file], file);
    const current = readOrNull(path);
    const rel = relative(root, path).split('\\').join('/');
    if (current === text) {
      console.log(`up to date  ${rel}`);
      continue;
    }
    if (args.check) {
      stale.push(rel);
      console.error(`out of date ${rel}`);
      continue;
    }
    writeFileSync(path, text, 'utf8');
    console.log(`wrote       ${rel}`);
  }
  if (stale.length > 0) {
    console.error('Run `npm run gen:guardian` and commit the result.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  if (err && Array.isArray(err.errors)) {
    for (const e of err.errors) console.error(e.text);
  }
  process.exitCode = 1;
});
