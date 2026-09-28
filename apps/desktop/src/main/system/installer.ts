/**
 * Guardian install, repair and upgrade (PROMPT §5 «Instalación del guardián», docs/DESKTOP.md
 * §6.6 «Reparar», ARCHITECTURE §13).
 *
 * Always the **bundled** binary (`<resources>/guardian/centrate-guardian[.exe]`) with **fixed**
 * arguments (`install`, `start`, `restart`), elevated per OS:
 * - Windows: `powershell.exe -NoProfile -NonInteractive -Command <fixed script>` running
 *   `Start-Process -Verb RunAs -Wait` on the path passed through an environment variable (no
 *   quoting of paths into code); the UAC «No» maps to `cancelled` (Win32 error 1223);
 * - macOS: `/usr/bin/osascript` with a fixed AppleScript that receives the path and action
 *   as `argv` and runs `do shell script (quoted form of …) with administrator privileges`
 *   (user cancel is error -128); `install` copies the binary to PrivilegedHelperTools itself;
 * - Linux: `/usr/bin/pkexec <binary> <action>` (126/127: dismissed or not authorised).
 *
 * «Reparar» picks the action from the unprivileged `centrate-guardian status` JSON: not
 * installed → `install` (installs and starts), stopped → `start`, running but not answering
 * → `restart`. On macOS and AppImage the app also installs the guardian on first launch and
 * reinstalls it when `health.version` is older than the bundled one (once per run, packaged
 * builds only); the Windows installer and the `.deb` do it themselves.
 */
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Platform } from '../../shared/ui-state';
import type { ExecResult, ExecRunner } from './exec';

export type GuardianAction = 'install' | 'start' | 'restart';
export type ElevationOutcome = 'started' | 'cancelled' | 'failed' | 'unsupported';

export const GUARDIAN_STATUS_TIMEOUT_MS = 5_000;
/** The user may take a while to type a password. */
export const ELEVATION_TIMEOUT_MS = 5 * 60_000;
export const WINDOWS_CANCELLED_EXIT = 1223;
export const GUARDIAN_EXE_ENV = 'CENTRATE_GUARDIAN_EXE';

export function guardianBinaryName(platform: Platform): string {
  return platform === 'win32' ? 'centrate-guardian.exe' : 'centrate-guardian';
}

/**
 * `<process.resourcesPath>/guardian/<binary>` when packaged; `<appPath>/resources/guardian`
 * when unpackaged. `null` when the file is not there.
 */
export function resolveGuardianBinary(options: {
  platform: Platform;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  exists?: (path: string) => boolean;
}): string | null {
  const path = options.platform === 'win32' ? win32 : posix;
  const name = guardianBinaryName(options.platform);
  const file = options.packaged
    ? path.join(options.resourcesPath, 'guardian', name)
    : path.join(options.appPath, 'resources', 'guardian', name);
  return (options.exists ?? existsSync)(file) ? file : null;
}

export interface ElevatedCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** The fixed PowerShell program for an action (the binary path comes from the environment). */
export function windowsElevationScript(action: GuardianAction): string {
  return (
    "$ErrorActionPreference = 'Stop'; " +
    `try { $p = Start-Process -FilePath $env:${GUARDIAN_EXE_ENV} -ArgumentList '${action}' ` +
    '-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } ' +
    'catch { $e = $_.Exception; ' +
    'while ($e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }; ' +
    `if ($e -and $e.NativeErrorCode -eq ${WINDOWS_CANCELLED_EXIT}) { exit ${WINDOWS_CANCELLED_EXIT} }; ` +
    'exit 1 }'
  );
}

const MAC_PROMPT =
  'Céntrate necesita permiso de administrador para instalar y arrancar el guardián.';

/** The elevated command for an action (pure: tested per OS). */
export function elevatedCommand(
  platform: Platform,
  binary: string,
  action: GuardianAction,
  env: Readonly<Record<string, string | undefined>> = {},
): ElevatedCommand {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows';
    return {
      file: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        windowsElevationScript(action),
      ],
      env: { [GUARDIAN_EXE_ENV]: binary },
    };
  }
  if (platform === 'darwin') {
    return {
      file: '/usr/bin/osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        `do shell script (quoted form of (item 1 of argv)) & " " & (quoted form of (item 2 of argv)) with prompt "${MAC_PROMPT}" with administrator privileges`,
        '-e',
        'end run',
        binary,
        action,
      ],
      env: {},
    };
  }
  return { file: '/usr/bin/pkexec', args: [binary, action], env: {} };
}

/** Maps the elevation helper's result. */
export function elevationOutcome(platform: Platform, result: ExecResult): ElevationOutcome {
  if (result.error === 'ENOENT') return 'unsupported';
  if (result.code === 0) return 'started';
  if (platform === 'win32' && result.code === WINDOWS_CANCELLED_EXIT) return 'cancelled';
  if (platform === 'darwin' && /-128\b|User cancel/i.test(result.stderr)) return 'cancelled';
  if (platform === 'linux' && (result.code === 126 || result.code === 127)) return 'cancelled';
  return 'failed';
}

export interface GuardianStatusOutput {
  installed: boolean;
  running: boolean;
  version: string;
}

/** `centrate-guardian status` prints one JSON line `{installed, running, version}`. */
export function parseStatusOutput(stdout: string): GuardianStatusOutput | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v['installed'] !== 'boolean' || typeof v['running'] !== 'boolean') return null;
    return {
      installed: v['installed'],
      running: v['running'],
      version: typeof v['version'] === 'string' ? v['version'] : '',
    };
  } catch {
    return null;
  }
}

/** `centrate-guardian version` prints `{"version": "0.1.0"}`. */
export function parseVersionOutput(stdout: string): string | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    return typeof v['version'] === 'string' && v['version'] !== '' ? v['version'] : null;
  } catch {
    return null;
  }
}

export function chooseRepairAction(status: GuardianStatusOutput | null): GuardianAction {
  if (!status || !status.installed) return 'install';
  return status.running ? 'restart' : 'start';
}

/** Numeric `major.minor.patch` comparison («v0.1.0», «0.1.0-rc1» → 0.1.0); unparsable is `null`. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Platforms where the app itself installs and upgrades the guardian. */
export function appManagesGuardian(
  platform: Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return platform === 'darwin' || (platform === 'linux' && Boolean(env['APPIMAGE']));
}

export interface InstallerDeps {
  platform: Platform;
  packaged: boolean;
  binary: string | null;
  env: Readonly<Record<string, string | undefined>>;
  exec: ExecRunner;
  log?: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
}

export class GuardianInstaller {
  private bundled: string | null | undefined = undefined;
  private autoInstallTried = false;
  private upgradeTried = false;
  private running: Promise<ElevationOutcome> | null = null;

  constructor(private readonly deps: InstallerDeps) {}

  /** Unprivileged `status` (installed, running); `null` without the binary or on error. */
  async status(): Promise<GuardianStatusOutput | null> {
    const { binary, exec } = this.deps;
    if (!binary) return null;
    const r = await exec(binary, ['status'], { timeoutMs: GUARDIAN_STATUS_TIMEOUT_MS });
    return r.code === 0 ? parseStatusOutput(r.stdout) : null;
  }

  /** Raw JSON of `status` for diagnostics (or the failure). */
  async statusText(): Promise<string> {
    const { binary, exec } = this.deps;
    if (!binary) return 'bundled guardian binary not found';
    const r = await exec(binary, ['status'], { timeoutMs: GUARDIAN_STATUS_TIMEOUT_MS });
    if (r.code === 0) return r.stdout.trim();
    return `status failed: code=${r.code ?? 'null'} error=${r.error ?? 'none'}`;
  }

  /** Version of the bundled binary (cached). */
  async bundledVersion(): Promise<string | null> {
    if (this.bundled !== undefined) return this.bundled;
    const { binary, exec } = this.deps;
    if (!binary) {
      this.bundled = null;
      return null;
    }
    const r = await exec(binary, ['version'], { timeoutMs: GUARDIAN_STATUS_TIMEOUT_MS });
    this.bundled = r.code === 0 ? parseVersionOutput(r.stdout) : null;
    return this.bundled;
  }

  /** Run one elevated action (one at a time). */
  runElevated(action: GuardianAction): Promise<ElevationOutcome> {
    if (this.running) return this.running;
    const { binary, platform, exec, env } = this.deps;
    if (!binary) return Promise.resolve('unsupported');
    const cmd = elevatedCommand(platform, binary, action, env);
    this.deps.log?.('guardian_elevate', { action });
    this.running = exec(cmd.file, cmd.args, { timeoutMs: ELEVATION_TIMEOUT_MS, env: cmd.env })
      .then((r) => {
        const outcome = elevationOutcome(platform, r);
        this.deps.log?.('guardian_elevate_done', { action, outcome, code: r.code });
        return outcome;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** «Reparar»: status → install / start / restart, elevated. */
  async repair(): Promise<ElevationOutcome> {
    if (!this.deps.binary) return 'unsupported';
    const status = await this.status();
    return this.runElevated(chooseRepairAction(status));
  }

  /** First launch on macOS / AppImage: install when `client.json` is missing (once per run). */
  async maybeAutoInstall(): Promise<ElevationOutcome | null> {
    if (this.autoInstallTried || !this.deps.packaged) return null;
    if (!appManagesGuardian(this.deps.platform, this.deps.env)) return null;
    this.autoInstallTried = true;
    const status = await this.status();
    if (status?.installed) return null;
    return this.runElevated('install');
  }

  /** macOS / AppImage: reinstall when the running guardian is older than the bundled one. */
  async maybeUpgrade(runningVersion: string): Promise<ElevationOutcome | null> {
    if (this.upgradeTried || !this.deps.packaged) return null;
    if (!appManagesGuardian(this.deps.platform, this.deps.env)) return null;
    const bundled = await this.bundledVersion();
    if (!bundled) return null;
    const cmp = compareVersions(runningVersion, bundled);
    if (cmp === null || cmp >= 0) return null;
    this.upgradeTried = true;
    this.deps.log?.('guardian_upgrade', { from: runningVersion, to: bundled });
    return this.runElevated('install');
  }
}
