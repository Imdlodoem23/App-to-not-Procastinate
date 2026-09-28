import { describe, expect, it } from 'vitest';
import type { PairErrorCode } from '../../src/background/state';
import { PAGES_ES } from '../../src/pages/i18n/es';
import { pairErrorText, parsePortInput } from '../../src/pages/shared/pairing-form';

describe('pairErrorText', () => {
  it('explains each claim error in Spanish, with what to do', () => {
    const codes: PairErrorCode[] = [
      'invalid_format',
      'code_invalid',
      'code_expired',
      'no_code',
      'peer_not_browser',
      'origin_not_allowed',
      'rate_limited',
      'unreachable',
      'timeout',
      'read_only',
      'unexpected',
    ];
    const texts = codes.map((error) =>
      pairErrorText({ ok: false, error, retryAfterSeconds: null }),
    );
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) expect(text).toMatch(/^[A-ZÁÉÍÓÚÑ].*\.$/);
    expect(texts[2]).toBe('El código ha caducado. Pide otro en la app con «Nuevo código».');
  });

  it('says how long to wait when rate limited', () => {
    expect(pairErrorText({ ok: false, error: 'rate_limited', retryAfterSeconds: 29.2 })).toBe(
      'Demasiados intentos. Espera 30 s y vuelve a probar.',
    );
  });

  it('covers a silent or failing background', () => {
    expect(pairErrorText(null)).toBe(PAGES_ES.pairing.extensionUnavailable);
    expect(pairErrorText({ ok: false, error: 'internal' })).toBe(
      PAGES_ES.pairing.errors.unexpected,
    );
  });
});

describe('parsePortInput', () => {
  it('empty is the default port; otherwise 1-65535', () => {
    expect(parsePortInput('')).toBeUndefined();
    expect(parsePortInput('  ')).toBeUndefined();
    expect(parsePortInput('47601')).toBe(47601);
    expect(parsePortInput(' 8080 ')).toBe(8080);
    expect(parsePortInput('0')).toBeNull();
    expect(parsePortInput('65536')).toBeNull();
    expect(parsePortInput('47 600')).toBeNull();
    expect(parsePortInput('abc')).toBeNull();
    expect(parsePortInput('-1')).toBeNull();
  });
});
