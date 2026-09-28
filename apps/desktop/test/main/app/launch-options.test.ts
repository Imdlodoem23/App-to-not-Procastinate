import { describe, expect, it } from 'vitest';
import { argValue, parseLaunchOptions, parseWorkArea } from '../../../src/main/app/launch-options';

const EXE = ['/opt/Céntrate/centrate'];

describe('launch options', () => {
  it('reads --hidden always, even packaged', () => {
    const packaged = parseLaunchOptions({ argv: [...EXE, '--hidden'], env: {}, packaged: true });
    expect(packaged.hidden).toBe(true);
    expect(parseLaunchOptions({ argv: EXE, env: {}, packaged: true }).hidden).toBe(false);
  });

  it('ignores every harness switch and override in a packaged app', () => {
    const options = parseLaunchOptions({
      argv: [...EXE, '--harness-state=idle', '--harness-show'],
      env: {
        CENTRATE_HARNESS: '1',
        CENTRATE_USER_DATA: '/tmp/u',
        CENTRATE_DATA_DIR: '/tmp/sys',
        CENTRATE_FAKE_WORKAREA: '0,0,800,600',
      },
      packaged: true,
    });
    expect(options.harness).toBeNull();
    expect(options.userDataDir).toBeNull();
    expect(options.sysDir).toBeNull();
  });

  it('parses the Playwright harness switches', () => {
    const options = parseLaunchOptions({
      argv: [
        'electron',
        'out/main/index.js',
        '--harness-state=compact-density',
        '--harness-display=1366x768@125',
        '--harness-theme=dark',
        '--harness-show',
      ],
      env: { CENTRATE_USER_DATA: '/tmp/e2e-1' },
      packaged: false,
    });
    expect(options.harness).toEqual({
      stateId: 'compact-density',
      display: '1366x768@125',
      fakeWorkArea: null,
      theme: 'dark',
      show: true,
    });
    expect(options.userDataDir).toBe('/tmp/e2e-1');
    expect(options.problems).toEqual([]);
  });

  it('accepts the environment form used by the capture script', () => {
    const options = parseLaunchOptions({
      argv: ['electron', '.', '--harness'],
      env: {
        CENTRATE_HARNESS_STATE: 'bloqueos',
        CENTRATE_FAKE_WORKAREA: '0, 0, 1366, 720',
        CENTRATE_HARNESS_SHOW: 'true',
      },
      packaged: false,
    });
    expect(options.harness).toMatchObject({
      stateId: 'bloqueos',
      display: null,
      fakeWorkArea: { x: 0, y: 0, width: 1366, height: 720 },
      show: true,
    });
    const envOnly = parseLaunchOptions({
      argv: EXE,
      env: { CENTRATE_HARNESS: '1' },
      packaged: false,
    });
    expect(envOnly.harness?.stateId).toBe('idle');
    expect(envOnly.harness?.show).toBe(false);
  });

  it('reports what it could not understand', () => {
    const options = parseLaunchOptions({
      argv: [...EXE, '--harness-state=idle', '--harness-theme=pink', '--harness-workarea=1,2,3'],
      env: {},
      packaged: false,
    });
    expect(options.harness?.theme).toBeNull();
    expect(options.harness?.fakeWorkArea).toBeNull();
    expect(options.problems).toHaveLength(2);
  });

  it('is off without any harness switch', () => {
    expect(parseLaunchOptions({ argv: EXE, env: {}, packaged: false }).harness).toBeNull();
  });
});

describe('argument helpers', () => {
  it('reads --name=value, --name value and bare flags', () => {
    expect(argValue(['--a=1'], '--a')).toBe('1');
    expect(argValue(['--a', '2'], '--a')).toBe('2');
    expect(argValue(['--a', '--b'], '--a')).toBe(true);
    expect(argValue(['--ab=1'], '--a')).toBeNull();
  });

  it('parses a work area', () => {
    expect(parseWorkArea('-1280,-200,1280,984')).toEqual({
      x: -1280,
      y: -200,
      width: 1280,
      height: 984,
    });
    expect(parseWorkArea('0,0,0,10')).toBeNull();
    expect(parseWorkArea('0,0,10.5,10')).toBeNull();
    expect(parseWorkArea('a,b,c,d')).toBeNull();
  });
});
