import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/lint-colors.mjs', import.meta.url));
const temps: string[] = [];

/** Creates a fixture tree ({ 'apps/desktop/src/a.tsx': [...lines] }) and returns its root. */
function fixture(files: Record<string, readonly string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'centrate-lint-colors-'));
  temps.push(root);
  for (const [path, lines] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
  }
  return root;
}

function lint(args: readonly string[], env: Record<string, string> = {}) {
  const { LINT_COLORS_ROOT: _ignored, ...base } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  const locations = result.stdout
    .split('\n')
    .map((line) => /^(\S+?:\d+):\d+: /.exec(line)?.[1])
    .filter((loc): loc is string => loc !== undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, locations };
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/lint-colors.mjs', () => {
  it('reports loose colors with file:line and exits 1', () => {
    const root = fixture({
      'apps/desktop/src/renderer/Bad.tsx': [
        "import { colors } from '@centrate/shared/design/tokens';", // 1
        "export const A = () => <div style={{ color: '#fff' }} />;", // 2 hex
        "export const B = { background: 'rgb(0 0 0)', fill: 'hsla(0, 0%, 0%, 0.5)' };", // 3
        'export const C = () => <Lock color="red" />;', // 4 named attribute
        "export const D = { backgroundColor: 'white' };", // 5 named style prop
        'export const E = <p className="text-red-500 bg-[#123456]" />;', // 6 palette + hex
        '// issue #123 and rgb(1, 2, 3) in a comment', // 7 ignored
        '/* color: #fff', // 8 ignored
        '   #000 */', // 9 ignored
        "export const F = 'https://example.com/#top';", // 10 not a color
        'export const G = colors.dark.red;', // 11 token
        "export type Tone = { color: 'red' | 'blue' };", // 12 type, not a value
        "export const H = `${'a'} // #0f0 inside a template`;", // 13 hex in a string
        "el.style.color = 'tomato';", // 14 named
        "export const I = '#ABCDEF80';", // 15 hex with alpha
      ],
      'apps/desktop/src/main/index.ts': ["new BrowserWindow({ backgroundColor: '#1C1C1C' });"],
      'apps/extension/src/popup.css': [
        '/* #fff */', // 1 ignored
        '.a { color: var(--fg); border: 1px solid #000; }', // 2 hex
        '.b { background: url("white.png"); outline-color: black; }', // 3 named
      ],
      'apps/extension/public/blocked.html': [
        '<!-- #fff -->', // 1 ignored
        '<body style="background: white">', // 2 named
        '<a href="#main" class="text-[red]">x</a>', // 3 arbitrary named
        '<svg><path fill="navy" stroke="currentColor"/></svg>', // 4 named attribute
      ],
      'apps/extension/public/manifest.json': ['{ "theme_color": "#ffffff" }'], // not scanned
    });
    const { status, locations, stdout } = lint(['--root', root]);
    expect(status).toBe(1);
    const bad = 'apps/desktop/src/renderer/Bad.tsx';
    expect([...new Set(locations)]).toEqual([
      'apps/desktop/src/main/index.ts:1',
      `${bad}:2`,
      `${bad}:3`,
      `${bad}:4`,
      `${bad}:5`,
      `${bad}:6`,
      `${bad}:13`,
      `${bad}:14`,
      `${bad}:15`,
      'apps/extension/public/blocked.html:2',
      'apps/extension/public/blocked.html:3',
      'apps/extension/public/blocked.html:4',
      'apps/extension/src/popup.css:2',
      'apps/extension/src/popup.css:3',
    ]);
    expect(locations.filter((l) => l === `${bad}:3`)).toHaveLength(2);
    expect(locations.filter((l) => l === `${bad}:6`)).toHaveLength(2);
    expect(stdout).toContain(`${bad}:2:46: hex color #fff`);
    expect(stdout).toContain('16 loose colors');
  });

  it('accepts tokens, allow-color markers and the design folder', () => {
    const root = fixture({
      'apps/desktop/src/ok.tsx': [
        "import { colors, cssVar } from '@centrate/shared/design/tokens';",
        "const a = { color: cssVar('fg'), background: 'transparent', fill: 'currentColor' };",
        "const b = { border: '1px solid var(--border)', boxShadow: 'none' };",
        'const c = <div className="bg-tile text-fg-muted border-border text-red-text" />;',
        "const d = '#1C1C1C'; // allow-color",
        "const e = <p style={{ color: 'white' }} />; /* allow-color */",
        "const f = colors.light.bg; const g = '#section-2'; const h = 'issue #12345';",
      ],
      'apps/extension/public/popup.html': [
        '<p style="color: black"><!-- allow-color --></p>',
        '<p style="color: var(--fg)">ok</p>',
      ],
      'packages/shared/src/design/tokens.css': [':root { --bg: #f0f0f0; }'],
    });
    const clean = lint(['--root', root]);
    expect(clean.stdout).toContain('no loose colors in 2 files');
    expect(clean.status).toBe(0);
    // Explicit paths, root from the environment: the design folder is always skipped.
    const design = lint(['packages/shared/src/design', 'apps/desktop/src/ok.tsx'], {
      LINT_COLORS_ROOT: root,
    });
    expect(design.status).toBe(0);
    expect(design.stdout).toContain('no loose colors in 1 file.');
  });

  it('catches named colors written the usual ways in TSX, CSS and HTML', () => {
    const root = fixture({
      'apps/desktop/src/Sneaky.tsx': [
        "const a = { color: active ? 'white' : 'black' };", // 1 expression after the key
        "ctx.fillStyle = 'red';", // 2 canvas
        "ctx.strokeStyle = 'black';", // 3
        "const b = { fillStyle: 'white' };", // 4
        'const c = `.x { color: white }`;', // 5 CSS in a template
        "style.textContent = '.y { border-color: navy }';", // 6 CSS in a string
        "el.setAttribute('fill', 'red');", // 7
        "el.setAttribute('style', 'color: red');", // 8
        "el.style['color'] = 'red';", // 9
        'const d = {', // 10
        '  backgroundColor:', // 11 key and value split by prettier
        "    'white',", // 12
        '};', // 13
        'const e = <p className="[color:red] shadow-[0_0_0_2px_red]" />;', // 14 two findings
        "const f = { backgroundImage: 'linear-gradient(red, blue)' };", // 15
        "const g = { filter: 'drop-shadow(0 0 2px red)' };", // 16
        "const h = ['color(display-p3 1 0 0)', 'color(srgb 1 0 0)'];", // 17 two findings
        'const i = {', // 18
        '  color: active', // 19
        "    ? 'white'", // 20
        "    : 'black',", // 21
        '};', // 22
        "ctx.shadowColor = 'black';", // 23
        "const j = <Icon fill={active ? 'red' : 'none'} />;", // 24
        "el.setAttributeNS(null, 'stroke', 'black');", // 25
        "const k = '#123';", // 26 short digits as a whole string
        "const l = { borderTop: '1px solid #333' };", // 27 short digits in a color value
        "const m = { color: 'red' as const };", // 28 as const is still a value
        'const n = <Chip color="blue" />;', // 29 accent props are named accent/tone
      ],
      'apps/desktop/src/sneaky.css': [
        '.a { background-image: linear-gradient(red, transparent); }',
        '.b { border-image: linear-gradient(red, blue) 1; }',
        '.c { filter: drop-shadow(0 0 2px red); }',
        '.d { -webkit-text-fill-color: white; }',
        '.e { -webkit-text-stroke: 1px black; }',
        '.f { color: color(display-p3 1 0 0); }',
      ],
      'apps/extension/public/sneaky.html': [
        '<svg><rect fill=red /></svg>',
        '<font color=red>x</font>',
        '<meta name="theme-color" content="white">',
      ],
    });
    const { status, locations, stdout } = lint(['--root', root]);
    expect(status).toBe(1);
    const tsx = 'apps/desktop/src/Sneaky.tsx';
    const tsxLines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 14, 15, 16, 17, 20, 21, 23, 24, 25, 26];
    expect([...new Set(locations)]).toEqual([
      ...[...tsxLines, 27, 28, 29].map((n) => `${tsx}:${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `apps/desktop/src/sneaky.css:${n}`),
      ...[1, 2, 3].map((n) => `apps/extension/public/sneaky.html:${n}`),
    ]);
    expect(locations.filter((l) => l === `${tsx}:1`)).toHaveLength(2);
    expect(locations.filter((l) => l === `${tsx}:14`)).toHaveLength(2);
    expect(locations.filter((l) => l === `${tsx}:17`)).toHaveLength(2);
    expect(stdout).toContain(`${tsx}:12:6: named color white in backgroundColor`);
    expect(stdout).toContain('name accent props `accent` or `tone`');
  });

  it('does not treat // or /* in JSX text as a comment', () => {
    const root = fixture({
      'apps/desktop/src/Help.tsx': [
        'export const A = () => (', // 1
        '  <p>', // 2
        "    Descarga en https://centrate.app <b style={{ color: '#f00' }}>ya</b>", // 3
        '  </p>', // 4
        ');', // 5
        'export const B = () => <p>Usa /* para comentar</p>;', // 6
        "const c = { color: '#0f0' };", // 7
        'export const D = () => <p>*/</p>;', // 8
        // Real comments around and inside JSX stay masked.
        'export const E = () => (', // 9
        '  <div // #fff between attributes', // 10
        '    className="bg-tile" /* #fff */', // 11
        '  >', // 12
        '    {/* #fff */}', // 13
        '    {n > 0 && <span>{n}</span>} {/* rgb(1, 2, 3) */}', // 14
        '  </div>', // 15
        '); // #abc', // 16
        'const id = <T,>(x: T): T => x; // #abc', // 17 generic arrow, not JSX
        'type F = <T>(x: T) => T; // #abc', // 18
        'const lt = a < b; // #abc', // 19
      ],
    });
    const { locations } = lint(['--root', root]);
    expect(locations).toEqual(['apps/desktop/src/Help.tsx:3', 'apps/desktop/src/Help.tsx:7']);
  });

  it('honors allow-color only inside a comment', () => {
    const root = fixture({
      'apps/desktop/src/allow.ts': [
        "const f = '// allow-color'; const g = '#ff0000';", // 1 marker in a string
        "const h = '/* allow-color */' + '#00ff00';", // 2
        "const i = '#0000ff'; // allow-color", // 3 real comment
        "const j = '#00ffff'; /* allow-color */", // 4 real comment
      ],
    });
    const { locations } = lint(['--root', root]);
    expect(locations).toEqual(['apps/desktop/src/allow.ts:1', 'apps/desktop/src/allow.ts:2']);
  });

  it('ignores ids, selectors, prose numbers and typed accent names', () => {
    const root = fixture({
      'apps/desktop/src/Ok.tsx': [
        "const a = 'Sesión #123 completada';",
        'const b = `Logro #100`;',
        'const c = <p>Paso #123 de la guía</p>;',
        'const d = <svg><rect fill="url(#fade)" /><use href="#bad" /></svg>;',
        'const e = <a href="#add">x</a>;',
        "const f = document.querySelector('#fab');",
        "const g = { color: 'green' as Accent };",
        "const h = { color: 'red' satisfies Accent };",
        'const i = <Tile accent="red" data-accent="red" tone="blue" />;',
        'class K { #add = 1; #bad() { return this.#add; } }',
        'const k = <p className="data-[state=red]:bg-tile supports-[display:grid]:grid" />;',
        "const l = { heroImage: 'white.png', icon: 'icons/red.svg' };",
        "const m = { borderColor: cssVar('red'), color: cssVar('redText') };",
        "type TileColor = 'green' | 'blue';",
        "type Fill = 'red';",
        "const n = { banner: 'Sin conexión a la red', hint: 'Es tan fácil' };",
      ],
      'apps/desktop/src/ok.css': [
        '#fab { color: var(--fg); }',
        '#add,',
        '#bad > .x { outline-color: var(--focus-ring); }',
        '.x { mask: url(#fade); fill: url(#bad); }',
        '.y { border-color: var(--red); color: var(--red-text); }',
      ],
      'apps/extension/public/ok.html': [
        '<p>Paso #123</p><a href="#bad">x</a>',
        '<svg><use xlink:href="#fade"/></svg>',
      ],
    });
    const { status, stdout } = lint(['--root', root]);
    expect(stdout).toContain('no loose colors in 3 files');
    expect(status).toBe(0);
  });

  it('flags token colors that fail as text', () => {
    const root = fixture({
      'apps/desktop/src/Text.tsx': [
        'const a = <span className="text-red">−10</span>;', // 1
        'const b = <span className="text-neutral hover:text-accent">x</span>;', // 2 two findings
        'const c = <i className="text-red-text text-accent-text bg-red border-neutral stroke-red" />;', // 3 ok
        "const d = { color: cssVar('red') };", // 4
        "const e = { color: 'var(--neutral)' };", // 5
      ],
      'apps/desktop/src/text.css': [
        '.x { color: var(--red); }', // 1
        '.y { @apply text-neutral; }', // 2
      ],
    });
    const { locations, stdout } = lint(['--root', root]);
    const tsx = 'apps/desktop/src/Text.tsx';
    expect(locations).toEqual([
      `${tsx}:1`,
      `${tsx}:2`,
      `${tsx}:2`,
      `${tsx}:4`,
      `${tsx}:5`,
      'apps/desktop/src/text.css:1',
      'apps/desktop/src/text.css:2',
    ]);
    expect(stdout).toContain('text-red is not a text color (under 4.5:1): use text-red-text');
    expect(stdout).toContain('use text-fg-muted');
    expect(stdout).toContain('use text-accent-text');
    expect(stdout).toContain("use cssVar('redText')");
    expect(stdout).toContain('var(--red) is not a text color (under 4.5:1): use var(--red-text)');
  });

  it('fails with exit code 2 on usage errors', () => {
    const root = fixture({});
    expect(lint(['--root', root, 'missing/dir']).status).toBe(2);
    expect(lint(['--no-such-flag']).status).toBe(2);
    expect(lint(['--root', join(root, 'nope')]).status).toBe(2);
  });
});
