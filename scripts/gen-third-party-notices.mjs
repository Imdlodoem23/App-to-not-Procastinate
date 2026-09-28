#!/usr/bin/env node
// Writes the third-party notices shipped with the desktop app and the extension (PROMPT.md §11
// «Legal»). ISC, MIT, BSD, zlib and Apache-2.0 ask for their copyright and licence notice in
// every copy, so each product carries this file:
//
//   apps/desktop/resources/third-party-notices.txt  packaged by electron-builder (extraResources)
//                                                   as <resources>/third-party-notices.txt
//   apps/extension/public/third-party-notices.txt   copied into dist/ and every extension zip
//
// What goes in, per product:
// 1. ASSET-LICENSES.json: every entry whose `shippedIn` lists the product (icons, models,
//    sounds, fonts). The text comes from the entry's `licenseText` when it is a file of the
//    repository or of node_modules, else from scripts/licenses/<license>.txt (Apache-2.0). An
//    entry without `shippedIn` whose files mention a shipped folder is an error.
// 2. npm packages: the bare imports of the product's source (and of the workspace packages it
//    imports), which the bundler inlines, plus the desktop's `dependencies`, which
//    electron-builder ships in node_modules, each with its production `dependencies`. The text
//    is the package's own LICENSE / NOTICE files. Packages that an ASSET-LICENSES entry covers
//    (`package`) are listed there instead.
// 3. Desktop only: the Go standard library and the modules of guardian/go.mod, compiled into
//    the guardian binary, with the texts in scripts/licenses/ (a new module fails the run until
//    its licence is added there).
//
//   node scripts/gen-third-party-notices.mjs           write both files
//   node scripts/gen-third-party-notices.mjs --check   write nothing; exit 1 when a file is
//                                                      missing or out of date (CI)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT, syncOutputs } from './brand-masters.mjs';

const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const REPO_URL = 'https://github.com/Imdlodoem23/App-to-not-Procastinate';
const LICENSES_DIR = 'scripts/licenses';

/** The products that ship a notices file. */
const PRODUCTS = {
  desktop: {
    out: 'apps/desktop/resources/third-party-notices.txt',
    title: 'Céntrate para escritorio',
    sourceDirs: ['apps/desktop/src'],
    /** electron-builder ships these `dependencies` (and theirs) in the app's node_modules. */
    shippedPackageJson: 'apps/desktop/package.json',
    go: true,
    electron: true,
  },
  extension: {
    out: 'apps/extension/public/third-party-notices.txt',
    title: 'Extensión de Céntrate',
    sourceDirs: ['apps/extension/src'],
    go: false,
    electron: false,
  },
};

/** Folders whose files end up in a product (for the «forgot shippedIn» check). */
const SHIPPED_PATHS = {
  desktop: ['apps/desktop/', 'packages/study-ai/', 'packages/shared/'],
  extension: ['apps/extension/'],
};

/**
 * Go code in the guardian binary. Every `require` of guardian/go.mod must be here with the same
 * version; the texts are copies of the modules' LICENSE (and PATENTS) files.
 */
const GO_MODULES = [
  {
    module: 'golang.org/x/sys',
    version: 'v0.48.0',
    license: 'BSD-3-Clause',
    texts: ['Go-BSD-3-Clause.txt', 'Go-PATENTS.txt'],
  },
  {
    module: 'github.com/kardianos/service',
    version: 'v1.3.0',
    license: 'Zlib',
    texts: ['kardianos-service-Zlib.txt'],
  },
];

const RULE = '='.repeat(80);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', 'test', 'tests', 'e2e', '__tests__']);

function fail(message) {
  console.error(`third-party notices: ${message}`);
  process.exit(1);
}

function readText(path) {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------------------
// Imports of the product's source
// ---------------------------------------------------------------------------------------

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) yield* sourceFiles(full);
    } else if (
      SOURCE_EXTS.has(name.slice(name.lastIndexOf('.'))) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

/**
 * Value imports only (`import type` / `export type` are erased by the compiler), plus CSS
 * `@import` (Tailwind's base CSS ends up in the app's stylesheet).
 */
const IMPORT_PATTERN =
  /\b(?:import|export)\s+(?!type\b)(?:[\w*{}\s,$]*?\bfrom\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)|@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g;

function importsOf(file) {
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;])\/\/.*$/gm, '$1');
  return [...code.matchAll(IMPORT_PATTERN)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** The npm package a bare specifier names, or null for relative, builtin and aliased ones. */
function packageOf(specifier) {
  if (/^[./]/.test(specifier) || specifier.includes('?') || specifier.includes(':')) return null;
  if (isBuiltin(specifier) || specifier === 'electron' || specifier.startsWith('electron/')) {
    return null;
  }
  if (specifier.startsWith('@renderer/')) return null; // electron.vite.config.ts alias
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Workspace packages by name (packages/* and apps/*). */
const WORKSPACES = new Map(
  ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group))
      .map((name) => join(REPO_ROOT, group, name))
      .filter((dir) => existsSync(join(dir, 'package.json')))
      .map((dir) => [readJson(join(dir, 'package.json')).name, dir]),
  ),
);

/**
 * npm packages the product's source imports: { name, from } with `from` the folder whose
 * node_modules resolution applies. Workspace packages are followed into their source.
 */
function importedPackages(sourceDirs) {
  const found = new Map();
  const visited = new Set();
  const scan = (dir, from) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    for (const file of sourceFiles(dir)) {
      for (const specifier of importsOf(file)) {
        const name = packageOf(specifier);
        if (!name) continue;
        if (WORKSPACES.has(name)) {
          const workspace = WORKSPACES.get(name);
          const src = join(workspace, 'src');
          scan(existsSync(src) ? src : workspace, workspace);
        } else if (!found.has(name)) {
          found.set(name, from);
        }
      }
    }
  };
  for (const dir of sourceDirs) {
    const abs = join(REPO_ROOT, dir);
    // The workspace folder: the nearest parent with a package.json.
    let from = abs;
    while (!existsSync(join(from, 'package.json'))) from = dirname(from);
    scan(abs, from);
  }
  return found;
}

// ---------------------------------------------------------------------------------------
// npm packages and their licences
// ---------------------------------------------------------------------------------------

/** Node's lookup of `name` from `fromDir` (node_modules of each parent folder). */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(candidate);
    if (dirname(dir) === dir) return null;
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function authorOf(pkg) {
  const author = pkg.author;
  if (!author) return null;
  return typeof author === 'string' ? author.replace(/\s*[<(].*$/, '') : author.name;
}

/** The package's web page: `homepage`, else its repository as an https URL. */
function homepageOf(pkg) {
  if (typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)) {
    return pkg.homepage.replace(/#readme$/, '');
  }
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return `https://www.npmjs.com/package/${pkg.name}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo}`;
  return repo
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^(ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$2/')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

/**
 * The platform packages a package installs as optional dependencies (one per OS and CPU, such
 * as koffi's prebuilt binaries): only one is installed, so they are named by their common
 * prefix rather than walked.
 */
function optionalNote(pkg) {
  const names = Object.keys(pkg.optionalDependencies ?? {}).sort();
  if (names.length === 0) return null;
  let prefix = names[0];
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const label = names.length > 1 && prefix.length > 1 ? `${prefix}*` : names.join(', ');
  return `Incluye el paquete de su plataforma (${label}), del mismo autor y con la misma licencia.`;
}

function licenseTextOf(dir, pkg) {
  const files = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort();
  if (files.length > 0) return files.map((name) => readText(join(dir, name))).join('\n\n');
  const author = authorOf(pkg);
  if (pkg.license === 'MIT' && author) {
    return (
      `(${pkg.name} no incluye archivo de licencia: texto MIT estándar con el autor de su ` +
      `package.json)\n\nMIT License\n\nCopyright (c) ${author}\n\n${MIT_TEXT}`
    );
  }
  return fail(`${pkg.name}@${pkg.version} (${pkg.license}) ships no licence file`);
}

/** Every package reachable from `roots` through `dependencies`, sorted by name. */
function packageClosure(roots) {
  const byDir = new Map();
  const visit = (name, fromDir, via) => {
    const dir = packageDir(name, fromDir);
    if (!dir) fail(`cannot resolve ${name} (needed by ${via}): run npm ci`);
    if (byDir.has(dir)) return;
    const pkg = readJson(join(dir, 'package.json'));
    byDir.set(dir, { dir, pkg });
    for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) visit(dep, dir, pkg.name);
  };
  for (const { name, from, via } of roots) visit(name, from, via);
  return [...byDir.values()].sort(
    (a, b) =>
      a.pkg.name.localeCompare(b.pkg.name, 'en') ||
      String(a.pkg.version).localeCompare(String(b.pkg.version), 'en'),
  );
}

function npmRoots(product) {
  const roots = [...importedPackages(product.sourceDirs)].map(([name, from]) => ({
    name,
    from,
    via: `${product.title} (import)`,
  }));
  if (product.shippedPackageJson) {
    const file = join(REPO_ROOT, product.shippedPackageJson);
    for (const name of Object.keys(readJson(file).dependencies ?? {})) {
      roots.push({ name, from: dirname(file), via: product.shippedPackageJson });
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------------------
// ASSET-LICENSES.json
// ---------------------------------------------------------------------------------------

const assetLicenses = readJson(join(REPO_ROOT, 'ASSET-LICENSES.json')).assets ?? [];

function assetsFor(productId) {
  const shipped = [];
  for (const entry of assetLicenses) {
    if (Array.isArray(entry.shippedIn)) {
      if (entry.shippedIn.includes(productId)) shipped.push(entry);
      continue;
    }
    const mentions = JSON.stringify([entry.files ?? [], entry.usedBy ?? []]);
    const folder = SHIPPED_PATHS[productId].find((path) => mentions.includes(path));
    if (folder) {
      fail(
        `ASSET-LICENSES.json «${entry.name}» mentions ${folder} but has no "shippedIn": ` +
          'list the products it ships in (desktop, extension, web)',
      );
    }
  }
  return shipped;
}

/** Céntrate's own work (MIT or CC0): listed with the app's licence, not as a third party. */
function isOwnWork(entry) {
  return entry.licenseText === 'LICENSE' || /Céntrate contributors/.test(entry.copyright ?? '');
}

function licenseFile(license) {
  const file = join(REPO_ROOT, LICENSES_DIR, `${license}.txt`);
  return existsSync(file) ? file : null;
}

/** A third-party asset's licence text, or null for a public domain dedication (CC0). */
function assetLicenseText(entry) {
  const reference = String(entry.licenseText ?? '').split(/\s/)[0];
  if (entry.license === 'CC0-1.0') return null; // public domain dedication: nothing to reproduce
  if (reference && !reference.includes('://')) {
    const file = join(REPO_ROOT, reference);
    if (!existsSync(file)) fail(`«${entry.name}»: ${reference} not found (run npm ci)`);
    return readText(file);
  }
  const file = licenseFile(entry.license);
  if (!file) fail(`«${entry.name}»: add the ${entry.license} text as ${LICENSES_DIR}/`);
  return readText(file);
}

// ---------------------------------------------------------------------------------------
// Go modules of the guardian
// ---------------------------------------------------------------------------------------

function goModules() {
  const goMod = readFileSync(join(REPO_ROOT, 'guardian/go.mod'), 'utf8');
  const goVersion = goMod.match(/^go\s+(\S+)/m)?.[1] ?? 'unknown';
  const required = [];
  for (const block of goMod.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
    for (const line of block[1].split('\n')) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match && !match[1].startsWith('//'))
        required.push({ module: match[1], version: match[2] });
    }
  }
  for (const match of goMod.matchAll(/^require\s+([^\s(]+)\s+(\S+)/gm)) {
    required.push({ module: match[1], version: match[2] });
  }
  for (const { module, version } of required) {
    const known = GO_MODULES.find((m) => m.module === module);
    if (!known || known.version !== version) {
      fail(
        `guardian/go.mod requires ${module} ${version}: add its LICENSE to ${LICENSES_DIR}/ ` +
          'and to GO_MODULES in scripts/gen-third-party-notices.mjs',
      );
    }
  }
  return [
    {
      module: 'Biblioteca estándar de Go',
      version: goVersion,
      license: 'BSD-3-Clause',
      texts: ['Go-BSD-3-Clause.txt', 'Go-PATENTS.txt'],
    },
    ...GO_MODULES.filter((m) => required.some((r) => r.module === m.module)),
  ];
}

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

function section(title, lines, text) {
  const head = [RULE, title, ...lines.filter(Boolean), RULE].join('\n');
  return text ? `${head}\n\n${text}\n` : `${head}\n`;
}

function notices(productId) {
  const product = PRODUCTS[productId];
  const shipped = assetsFor(productId);
  const own = shipped.filter(isOwnWork);
  const assets = shipped.filter((entry) => !isOwnWork(entry));
  const coveredPackages = new Set(shipped.map((a) => a.package).filter(Boolean));
  const packages = packageClosure(npmRoots(product)).filter(
    ({ pkg }) => !coveredPackages.has(pkg.name),
  );
  const go = product.go ? goModules() : [];

  const contents = [
    ...assets.map((a) => `- ${a.name} (${a.license})`),
    ...packages.map(({ pkg }) => `- ${pkg.name} ${pkg.version} (${pkg.license})`),
    ...go.map((m) => `- ${m.module} ${m.version} (${m.license})`),
  ];

  const parts = [];
  parts.push(
    [
      `${product.title}: avisos de terceros`,
      '',
      'Céntrate es software libre con licencia MIT (abajo). Incluye el trabajo de terceros de',
      'esta lista, cada uno con su licencia original. La lista de recursos, con los archivos que',
      'usa cada uno, está en ASSET-LICENSES.json:',
      `${REPO_URL}/blob/main/ASSET-LICENSES.json`,
      '',
      'Archivo generado por scripts/gen-third-party-notices.mjs: no lo edites a mano.',
      '',
      'Contenido:',
      ...contents,
      '',
    ].join('\n'),
  );

  const ownList = own.map(
    (entry) =>
      `- ${entry.name}: ${entry.license === 'CC0-1.0' ? 'dominio público (CC0 1.0)' : entry.license}`,
  );
  parts.push(
    section(
      'Céntrate',
      [REPO_URL, 'Licencia: MIT'],
      readText(join(REPO_ROOT, 'LICENSE')) +
        (ownList.length > 0
          ? `\n\nTrabajo original de Céntrate incluido en este producto:\n${ownList.join('\n')}`
          : ''),
    ),
  );

  if (product.electron) {
    parts.push(
      section(
        'Electron y Chromium',
        ['https://www.electronjs.org · https://www.chromium.org'],
        'Sus licencias y avisos van junto a la app, en la carpeta de instalación:\n' +
          'LICENSE.electron.txt y LICENSES.chromium.html.',
      ),
    );
  }

  const apacheShown = new Set();
  for (const entry of assets) {
    const lines = [
      `${entry.name}${entry.version ? ` ${entry.version}` : ''}` +
        `${entry.package ? ` (paquete npm ${entry.package})` : ''}`,
      entry.source && !/^original work/.test(entry.source) ? entry.source : null,
      `Licencia: ${entry.license}`,
      entry.copyright,
      ...(entry.additionalLicenses ?? []).map(
        (extra) => `${extra.license}: ${extra.copyright}. ${extra.appliesTo}`,
      ),
    ];
    let text = assetLicenseText(entry);
    if (text === null) {
      text = `Dominio público (CC0 1.0 Universal): ${entry.licenseText}`;
    } else if (entry.license === 'Apache-2.0') {
      // The Apache-2.0 text once; later entries point back to it.
      if (apacheShown.size > 0) text = 'Licencia: el texto de Apache-2.0 de más arriba.';
      apacheShown.add(entry.name);
    }
    parts.push(section(lines[0], lines.slice(1), text));
  }

  for (const { dir, pkg } of packages) {
    parts.push(
      section(
        `${pkg.name} ${pkg.version} (npm)`,
        [homepageOf(pkg), `Licencia: ${pkg.license}`, optionalNote(pkg)],
        licenseTextOf(dir, pkg),
      ),
    );
  }
  if (go.length > 0) {
    parts.push(
      section(
        'Guardián (centrate-guardian)',
        ['El servicio del guardián es un programa en Go; lleva compilado este código de terceros.'],
        null,
      ),
    );
    for (const m of go) {
      parts.push(
        section(
          `${m.module} ${m.version}`,
          [`Licencia: ${m.license}`],
          m.texts.map((name) => readText(join(REPO_ROOT, LICENSES_DIR, name))).join('\n\n'),
        ),
      );
    }
  }

  return `${parts.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}

const outputs = new Map(
  Object.entries(PRODUCTS).map(([id, product]) => [product.out, notices(id)]),
);

// Sanity check before writing: every product lists at least its own licence.
for (const [path, text] of outputs) {
  if (!text.includes('MIT License')) fail(`${path}: missing Céntrate's licence`);
}

syncOutputs(outputs, {
  check: args.check,
  what: 'third-party notices',
  command: 'node scripts/gen-third-party-notices.mjs',
});
