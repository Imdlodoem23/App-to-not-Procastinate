// Builds the extension and zips dist/ into release/Centrate-extension.zip (Chromium: Chrome,
// Edge, Brave) and release/Centrate-extension-firefox.zip (the same files with the Firefox
// manifest, manifest.mjs). Firefox users get the signed .xpi (sign-firefox.mjs).
// Usage: node package.mjs [--version X.Y.Z]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync } from 'fflate';
import { manifestFor } from './manifest.mjs';

const { values } = parseArgs({ options: { version: { type: 'string' } } });
execFileSync(process.execPath, ['build.mjs', '--engine', 'chromium'], { stdio: 'inherit' });

const manifestPath = join('dist', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (values.version) {
  manifest.version = values.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
const files = collect('dist');
const packages = [
  ['Centrate-extension.zip', files],
  [
    'Centrate-extension-firefox.zip',
    {
      ...files,
      'manifest.json': Buffer.from(
        `${JSON.stringify(manifestFor(manifest, 'firefox'), null, 2)}\n`,
      ),
    },
  ],
];
for (const [name, contents] of packages) {
  const zip = zipSync(contents, { level: 9 });
  writeFileSync(join('release', name), zip);
  console.log(`release/${name} (${zip.length} bytes)`);
}
