import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileLogger,
  createMemoryLogger,
  formatLogLine,
  logRendererError,
  scrubLogText,
  setAppLog,
} from '../../../src/main/logs/logger';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('app log', () => {
  it('never keeps tokens, bearer values or the home directory', () => {
    const text = scrubLogText(
      `token cta_AbCdEfGh12345678 and cte_zzzzzzzzzzzz Authorization: Bearer abc.def ${homedir()}/secret`,
    );
    expect(text).not.toContain('AbCdEfGh');
    expect(text).not.toContain('zzzzzzzz');
    expect(text).not.toContain('abc.def');
    if (homedir().length > 1) expect(text).not.toContain(homedir());
    expect(text).toContain('cta_[redacted]');
  });

  it('formats one line with scrubbed fields', () => {
    const line = formatLogLine(0, 'info', 'guardian_link', {
      status: 'down',
      reason: 'unreachable',
      note: 'two words',
      skip: undefined,
    });
    expect(line).toBe(
      '1970-01-01T00:00:00.000Z INFO guardian_link status=down reason=unreachable note="two words"',
    );
  });

  it('rotates at the size limit and keeps three files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centrate-log-'));
    dirs.push(dir);
    const log = createFileLogger({ dir, maxBytes: 300, maxFiles: 3, now: () => 0 });
    for (let i = 0; i < 40; i += 1) log.info('event_number', { i });
    expect(existsSync(join(dir, 'app.log'))).toBe(true);
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true);
    expect(existsSync(join(dir, 'app.log.2'))).toBe(true);
    expect(existsSync(join(dir, 'app.log.3'))).toBe(false);
    expect(readFileSync(join(dir, 'app.log'), 'utf8').length).toBeLessThanOrEqual(300);
    const tail = log.tail(5);
    expect(tail).toHaveLength(5);
    expect(tail.at(-1)).toContain('i=39');
  });

  it('logs renderer errors short and without file paths', () => {
    const mem = createMemoryLogger(() => 0);
    setAppLog(mem);
    logRendererError(
      'TypeError: x is undefined\nsecond line with the typed phrase',
      'TypeError: x\n    at render (file:///home/me/app/out/renderer/assets/index-abc.js:10:5)\n    at y (index.js:1:1)',
    );
    expect(mem.lines[0]).toContain('renderer_error');
    expect(mem.lines[0]).not.toContain('typed phrase');
    expect(mem.lines[0]).not.toContain('/home/me');
  });
});
