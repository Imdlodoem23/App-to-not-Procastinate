// Builds the extension and zips dist/ into release/Centrate-extension.zip.
// Usage: node package.mjs [--version X.Y.Z]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync } from 'fflate';

const { values } = parseArgs({ options: { version: { type: 'string' } } });
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

const manifestPath = join('dist', 'manifest.json');
if (values.version) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = values.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function collect(dir, files = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, files);
    else files[relative('dist', full).split('\\').join('/')] = readFileSync(full);
  }
  return files;
}

mkdirSync('release', { recursive: true });
const zip = zipSync(collect('dist'), { level: 9 });
writeFileSync(join('release', 'Centrate-extension.zip'), zip);
console.log(`release/Centrate-extension.zip (${zip.length} bytes)`);
