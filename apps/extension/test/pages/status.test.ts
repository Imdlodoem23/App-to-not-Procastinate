import { describe, expect, it } from 'vitest';
import type { ExtensionProblem } from '../../src/background/state';
import { formatClock } from '../../src/pages/shared/format';
import {
  canRetry,
  connectionLine,
  noticesFor,
  pairingNeed,
  retryOffered,
  retryResult,
} from '../../src/pages/shared/status';
import { NOW, snapshot } from './fixtures';

const unpaired = () =>
  snapshot({
    paired: false,
    pairing: null,
    link: 'unknown',
    protection: 'off',
    problems: ['not_paired'],
    rules: null,
  });

describe('connectionLine', () => {
  it('«● Guardián conectado» / «Guardián no responde»', () => {
    expect(connectionLine(snapshot())).toEqual({ tone: 'green', text: 'Guardián conectado' });
    expect(connectionLine(snapshot({ link: 'unreachable', protection: 'cached' }))).toEqual({
      tone: 'orange',
      text: 'Guardián no responde',
    });
  });

  it('covers every link state', () => {
    expect(connectionLine(null).text).toBe('Conectando con el guardián…');
    expect(connectionLine(unpaired())).toEqual({ tone: 'neutral', text: 'Sin emparejar' });
    expect(connectionLine(snapshot({ link: 'unknown' })).tone).toBe('neutral');
    expect(connectionLine(snapshot({ link: 'unauthorized' })).tone).toBe('red');
    expect(connectionLine(snapshot({ link: 'untrusted' })).tone).toBe('red');
    expect(connectionLine(snapshot({ link: 'error' })).tone).toBe('orange');
    // Revoked, even before the worker retried.
    expect(connectionLine(snapshot({ link: 'unknown', problems: ['unauthorized'] }))).toEqual({
      tone: 'red',
      text: 'Emparejamiento revocado',
    });
  });
});

describe('noticesFor', () => {
  it('shows nothing when all is well, and no notice for «not paired» (the form is the message)', () => {
    expect(noticesFor(snapshot())).toEqual([]);
    expect(noticesFor(unpaired())).toEqual([]);
    expect(noticesFor(null)).toEqual([]);
  });

  it('asks for the host permission with a button', () => {
    const [notice] = noticesFor(
      snapshot({ problems: ['host_permission_missing'], protection: 'limited' }),
    );
    expect(notice).toMatchObject({ tone: 'red', action: { kind: 'grant', label: 'Dar permiso' } });
  });

  it('keeps the blocks when the guardian is down, and says so', () => {
    const [cached] = noticesFor(
      snapshot({ link: 'unreachable', problems: ['guardian_unreachable'] }),
    );
    expect(cached?.text).toMatch(/siguen hasta que terminen/);
    expect(cached?.action?.kind).toBe('retry');
    const [empty] = noticesFor(
      snapshot({ link: 'unreachable', problems: ['guardian_unreachable'], blocks: [] }),
    );
    expect(empty?.text).toMatch(/abre Céntrate/);
  });

  it('links incognito to the guide, in the browser’s own words', () => {
    const [chrome] = noticesFor(snapshot({ problems: ['incognito_not_allowed'] }));
    expect(chrome).toMatchObject({
      tone: 'orange',
      action: { kind: 'guide', section: 'incognito' },
    });
    expect(chrome?.text).toMatch(/^En incógnito/);
    const [edge] = noticesFor(
      snapshot({
        problems: ['incognito_not_allowed'],
        browser: { family: 'edge', engine: 'chromium', version: '131' },
      }),
    );
    expect(edge?.text).toMatch(/^En InPrivate/);
    const [firefox] = noticesFor(
      snapshot({
        problems: ['incognito_not_allowed'],
        browser: { family: 'firefox', engine: 'firefox', version: '131.0' },
      }),
    );
    expect(firefox?.text).toMatch(/^En las ventanas privadas/);
  });

  it('has a Spanish message for every problem, in the snapshot order', () => {
    const all: ExtensionProblem[] = [
      'not_paired',
      'unauthorized',
      'host_permission_missing',
      'guardian_unreachable',
      'untrusted_rules',
      'browser_mismatch',
      'peer_not_browser',
      'origin_not_allowed',
      'guardian_error',
      'incognito_not_allowed',
    ];
    const notices = noticesFor(snapshot({ problems: all }));
    expect(notices.map((n) => n.problem)).toEqual(all.slice(1));
    for (const n of notices) expect(n.text).toMatch(/^[A-ZÁÉÍÓÚÑ¿¡]/);
  });
});

describe('pairingNeed and canRetry', () => {
  it('shows the form when not paired, revoked or bound to another browser', () => {
    expect(pairingNeed(null)).toBe('none');
    expect(pairingNeed(snapshot())).toBe('none');
    expect(pairingNeed(unpaired())).toBe('first');
    expect(pairingNeed(snapshot({ problems: ['unauthorized'] }))).toBe('again');
    expect(pairingNeed(snapshot({ problems: ['browser_mismatch'] }))).toBe('again');
  });

  it('offers «Reintentar» only while a paired guardian is not answering', () => {
    expect(canRetry(snapshot())).toBe(false);
    expect(canRetry(unpaired())).toBe(false);
    expect(canRetry(snapshot({ link: 'unreachable' }))).toBe(true);
    expect(canRetry(snapshot({ link: 'error' }))).toBe(true);
    expect(canRetry(snapshot({ link: 'unauthorized' }))).toBe(false);
  });

  it('leaves «Reintentar» to the warning when one offers it', () => {
    const down = snapshot({
      link: 'unreachable',
      protection: 'cached',
      problems: ['guardian_unreachable'],
    });
    expect(noticesFor(down)[0]?.action?.kind).toBe('retry');
    expect(canRetry(down)).toBe(false);
  });
});

describe('retryResult («Reintentar» leaves a dated fact, PROMPT §10)', () => {
  const down = snapshot({
    link: 'unreachable',
    protection: 'cached',
    problems: ['guardian_unreachable'],
  });
  const at = NOW + 42 * 60_000;
  const time = formatClock(at);

  it('says nothing before a retry ran, or once the problem is gone', () => {
    expect(retryResult(down, null)).toBeNull();
    expect(retryResult(snapshot(), at)).toBeNull();
    expect(retryResult(null, at)).toBeNull();
  });

  it('the guardian still down: «Sigue sin responder · comprobado a las 17:42»', () => {
    expect(retryResult(down, at)).toEqual({
      notice: `Sigue sin responder · comprobado a las ${time}`,
      footer: `Guardián no responde · comprobado a las ${time}`,
    });
  });

  it('another failure that «Reintentar» offers to fix: «Sigue fallando · …»', () => {
    const untrusted = snapshot({ link: 'untrusted', problems: ['untrusted_rules'] });
    expect(retryResult(untrusted, at)?.notice).toBe(`Sigue fallando · comprobado a las ${time}`);
    const failing = snapshot({ link: 'error', problems: [] });
    expect(canRetry(failing)).toBe(true);
    expect(retryResult(failing, at)?.footer).toBe(`Error del guardián · comprobado a las ${time}`);
  });

  it('retryOffered: a warning or the footer offers it', () => {
    expect(retryOffered(down)).toBe(true);
    expect(retryOffered(snapshot({ link: 'error', problems: [] }))).toBe(true);
    expect(retryOffered(snapshot())).toBe(false);
    expect(retryOffered(snapshot({ link: 'unauthorized', problems: ['unauthorized'] }))).toBe(
      false,
    );
    expect(retryOffered(null)).toBe(false);
  });
});
