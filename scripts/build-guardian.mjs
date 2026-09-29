// Builds the guardian for the current OS into --out (default apps/desktop/resources/guardian).
// macOS gets a universal binary (arm64 + amd64 merged with lipo).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    version: { type: 'string', default: '0.0.0-dev' },
    out: { type: 'string', default: 'apps/desktop/resources/guardian' },
  },
});
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, values.out);
const guardianDir = join(root, 'guardian');
const ldflags = `-s -w -X github.com/imdlodoem23/centrate/guardian/internal/version.Version=${values.version}`;
mkdirSync(out, { recursive: true });

function goBuild(goos, goarch, target) {
  console.log(`go build ${goos}/${goarch} -> ${target}`);
  execFileSync(
    'go',
    ['build', '-trimpath', '-ldflags', ldflags, '-o', target, './cmd/centrate-guardian'],
    {
      cwd: guardianDir,
      stdio: 'inherit',
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    },
  );
}

if (process.platform === 'win32') {
  goBuild('windows', 'amd64', join(out, 'centrate-guardian.exe'));
} else if (process.platform === 'darwin') {
  const arm = join(out, 'centrate-guardian-arm64');
  const amd = join(out, 'centrate-guardian-amd64');
  goBuild('darwin', 'arm64', arm);
  goBuild('darwin', 'amd64', amd);
  execFileSync('lipo', ['-create', '-output', join(out, 'centrate-guardian'), arm, amd], {
    stdio: 'inherit',
  });
  rmSync(arm);
  rmSync(amd);
} else {
  goBuild('linux', 'amd64', join(out, 'centrate-guardian'));
}
