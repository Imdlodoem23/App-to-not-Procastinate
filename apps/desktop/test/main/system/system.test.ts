import {
  createGuardianClient,
  GuardianApiError,
  type GuardianClient,
} from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { createMemoryLogger } from '../../../src/main/logs/logger';
import { buildDiagnostics } from '../../../src/main/system/diagnostics';
import type { ExecResult, ExecRunner } from '../../../src/main/system/exec';
import {
  GuardianInstaller,
  chooseRepairAction,
  compareVersions,
  elevatedCommand,
  elevationOutcome,
  parseStatusOutput,
  resolveGuardianBinary,
  windowsElevationScript,
} from '../../../src/main/system/installer';
import {
  normalizeProcessNames,
  parsePsOutput,
  parseTasklistCsv,
} from '../../../src/main/system/processes';
import { HARNESS_NOW, harnessFixture } from '../../../src/shared/fixtures';

const result = (patch: Partial<ExecResult>): ExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  error: null,
  ...patch,
});

describe('guardian binary and elevation', () => {
  it('resolves the bundled binary', () => {
    const exists = () => true;
    expect(
      resolveGuardianBinary({
        platform: 'win32',
        packaged: true,
        resourcesPath: 'C:\\P\\resources',
        appPath: 'x',
        exists,
      }),
    ).toBe('C:\\P\\resources\\guardian\\centrate-guardian.exe');
    expect(
      resolveGuardianBinary({
        platform: 'darwin',
        packaged: true,
        resourcesPath: '/A/Resources',
        appPath: 'x',
        exists,
      }),
    ).toBe('/A/Resources/guardian/centrate-guardian');
    expect(
      resolveGuardianBinary({
        platform: 'linux',
        packaged: false,
        resourcesPath: '/r',
        appPath: '/dev/app',
        exists,
      }),
    ).toBe('/dev/app/resources/guardian/centrate-guardian');
    expect(
      resolveGuardianBinary({
        platform: 'linux',
        packaged: true,
        resourcesPath: '/r',
        appPath: '/a',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('builds fixed elevated commands per OS (the path is never spliced into code)', () => {
    const bin = 'C:\\Program Files\\Céntrate\\resources\\guardian\\centrate-guardian.exe';
    const win = elevatedCommand('win32', bin, 'install', { SystemRoot: 'C:\\Windows' });
    expect(win.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(win.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
    ]);
    expect(win.args[5]).toBe(windowsElevationScript('install'));
    expect(win.args[5]).toContain("-ArgumentList 'install' -Verb RunAs");
    expect(win.args[5]).not.toContain(bin);
    expect(win.env).toEqual({ CENTRATE_GUARDIAN_EXE: bin });

    const macBin = '/Applications/Céntrate.app/Contents/Resources/guardian/centrate-guardian';
    const mac = elevatedCommand('darwin', macBin, 'start');
    expect(mac.file).toBe('/usr/bin/osascript');
    expect(mac.args.slice(-2)).toEqual([macBin, 'start']);
    expect(mac.args.join(' ')).toContain('with administrator privileges');
    expect(mac.args.slice(0, -2).join(' ')).not.toContain(macBin);

    expect(
      elevatedCommand('linux', '/opt/Céntrate/resources/guardian/centrate-guardian', 'restart'),
    ).toEqual({
      file: '/usr/bin/pkexec',
      args: ['/opt/Céntrate/resources/guardian/centrate-guardian', 'restart'],
      env: {},
    });
  });

  it('maps the helper results', () => {
    expect(elevationOutcome('win32', result({ code: 0 }))).toBe('started');
    expect(elevationOutcome('win32', result({ code: 1223 }))).toBe('cancelled');
    expect(
      elevationOutcome(
        'darwin',
        result({ code: 1, stderr: 'execution error: User canceled. (-128)' }),
      ),
    ).toBe('cancelled');
    expect(elevationOutcome('linux', result({ code: 126 }))).toBe('cancelled');
    expect(elevationOutcome('linux', result({ code: 1 }))).toBe('failed');
    expect(elevationOutcome('linux', result({ code: null, error: 'ENOENT' }))).toBe('unsupported');
  });

  it('chooses install, start or restart from `status`', () => {
    expect(parseStatusOutput('{"installed":true,"running":false,"version":"0.1.0"}\n')).toEqual({
      installed: true,
      running: false,
      version: '0.1.0',
    });
    expect(parseStatusOutput('garbage')).toBeNull();
    expect(chooseRepairAction(null)).toBe('install');
    expect(chooseRepairAction({ installed: false, running: false, version: '' })).toBe('install');
    expect(chooseRepairAction({ installed: true, running: false, version: '' })).toBe('start');
    expect(chooseRepairAction({ installed: true, running: true, version: '' })).toBe('restart');
  });

  it('compares versions', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('dev', '1.0.0')).toBeNull();
  });

  it('repairs through the elevated helper and upgrades only where the app manages the guardian', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: ExecRunner = async (file, args) => {
      calls.push({ file, args });
      if (args[0] === 'status')
        return result({ stdout: '{"installed":true,"running":false,"version":"0.2.0"}' });
      if (args[0] === 'version') return result({ stdout: '{"version":"0.2.0"}' });
      return result({ code: 0 });
    };
    const linux = new GuardianInstaller({
      platform: 'linux',
      packaged: true,
      binary: '/g/centrate-guardian',
      env: {},
      exec,
    });
    expect(await linux.repair()).toBe('started');
    expect(calls.at(-1)).toEqual({
      file: '/usr/bin/pkexec',
      args: ['/g/centrate-guardian', 'start'],
    });
    // .deb (no APPIMAGE): the package manager upgrades the guardian, not the app.
    expect(await linux.maybeUpgrade('0.1.0')).toBeNull();
    const appImage = new GuardianInstaller({
      platform: 'linux',
      packaged: true,
      binary: '/tmp/.mount/g',
      env: { APPIMAGE: '/home/u/Centrate.AppImage' },
      exec,
    });
    expect(await appImage.maybeUpgrade('0.2.0')).toBeNull();
    expect(await appImage.maybeUpgrade('0.1.0')).toBe('started');
    expect(calls.at(-1)?.args).toEqual(['/tmp/.mount/g', 'install']);
    expect(await appImage.maybeUpgrade('0.1.0')).toBeNull();
    const dev = new GuardianInstaller({
      platform: 'darwin',
      packaged: false,
      binary: '/g',
      env: {},
      exec,
    });
    expect(await dev.maybeUpgrade('0.0.1')).toBeNull();
    expect(
      await new GuardianInstaller({
        platform: 'win32',
        packaged: true,
        binary: null,
        env: {},
        exec,
      }).repair(),
    ).toBe('unsupported');
  });
});

describe('process names', () => {
  it('parses tasklist and ps output', () => {
    expect(
      parseTasklistCsv(
        '"Discord.exe","1234","Console","1","120.000 K"\r\n"steam.exe","99","Console","1","1 K"\r\n',
      ),
    ).toEqual(['Discord.exe', 'steam.exe']);
    expect(parsePsOutput('Safari\nDiscord\n\n')).toEqual(['Safari', 'Discord']);
    expect(
      normalizeProcessNames(['steam.exe', 'Steam.exe', '[kworker/0:1]', 'Code', '', 'a/b']),
    ).toEqual(['Code', 'steam.exe']);
  });
});

describe('«Copiar diagnóstico»', () => {
  it('uses /v1/diagnostics while the guardian answers', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    const log = createMemoryLogger(() => 0);
    log.info('guardian_link', { status: 'ok' });
    const snapshot = harnessFixture('one-block').snapshot;
    const r = await buildDiagnostics({
      client: mock,
      clock,
      snapshot,
      appLog: log,
      sysDir: '/var/lib/centrate',
      platform: 'linux',
      guardianStatus: async () => '{}',
      readText: () => null,
      runtime: { os: 'linux 6', arch: 'x64', electron: '44', node: '24' },
    });
    expect(r.source).toBe('guardian');
    expect(r.text).toContain('/v1/diagnostics');
    expect(r.text).toContain('guardian_link');
    // Counts only: no reasons or services from the snapshot.
    expect(r.text).not.toContain('Quiero aprobar mates');
    expect(r.text).not.toContain('youtube');
  });

  it('falls back to health, status and guardian.log when the guardian does not answer', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const client: GuardianClient = createGuardianClient({
      token: 'cta_secretsecret1234',
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED');
      },
    });
    const r = await buildDiagnostics({
      client,
      clock,
      snapshot: harnessFixture('protection-broken').snapshot,
      appLog: createMemoryLogger(),
      sysDir: '/var/lib/centrate',
      platform: 'linux',
      guardianStatus: async () => '{"installed":true,"running":false,"version":"0.1.0"}',
      readText: (path) =>
        path === '/var/lib/centrate/logs/guardian.log'
          ? 'line 1\nline 2 cta_leakedtoken99\n'
          : null,
      runtime: { os: 'linux 6', arch: 'x64', electron: null, node: '24' },
    });
    expect(r.source).toBe('fallback');
    expect(r.text).toContain('health: unreachable');
    expect(r.text).toContain('"running":false');
    expect(r.text).toContain('line 1');
    expect(r.text).not.toContain('leakedtoken');
    expect(r.text).not.toContain('secretsecret');
    expect(new GuardianApiError(0, 'x', 'y')).toBeInstanceOf(Error);
  });
});
