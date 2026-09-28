/**
 * The pages' Spanish copy (PROMPT §10 «Textos»): sentence case, typographic minus, no
 * leftover English, and the page strings live in i18n/es.ts (not in the page scripts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGES_ES } from '../../src/pages/i18n/es';

const PAGES_DIR = join(import.meta.dirname, '../../src/pages');

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) strings(v, out);
  }
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('Spanish copy', () => {
  const all = strings(PAGES_ES);

  it('never writes a hyphen as a minus sign', () => {
    for (const s of all) expect(s).not.toMatch(/(^|\s)-\d/);
  });

  it('uses sentence case (no Title Case Words after the first)', () => {
    const titleCase = /^(?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+ ){2,}[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/;
    for (const s of all) expect(s).not.toMatch(titleCase);
  });

  it('keeps UI text out of the page scripts', () => {
    const scripts = files(PAGES_DIR).filter(
      (f) => f.endsWith('.ts') && !f.includes(`${join('i18n', '')}`),
    );
    for (const file of scripts) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      // Spanish words with accents or «» only appear in es.ts.
      expect(source, file).not.toMatch(/'[^'\n]*[áéíóúñ¿¡«][^'\n]*'/);
    }
  });

  it('renders every humor line with and without a known end', () => {
    const context = { name: 'YouTube', inlineName: 'YouTube', time: '43 minutos' };
    for (const line of PAGES_ES.blocked.humor) {
      expect(line(context)).toMatch(/\.$/);
      const untimed = line({ ...context, time: null });
      if (untimed !== null) expect(untimed).not.toContain('null');
    }
    expect(
      PAGES_ES.blocked.humor.filter((line) => line({ ...context, time: null }) !== null).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('names private windows as each browser does', () => {
    expect(PAGES_ES.common.privateName('chrome')).toBe('incógnito');
    expect(PAGES_ES.common.privateName('edge')).toBe('InPrivate');
    expect(PAGES_ES.common.privateName('firefox')).toBe('ventanas privadas');
  });

  it("the incognito state agrees with each browser's label (gender and number)", () => {
    const state = PAGES_ES.guide.incognito.state;
    expect(state('firefox', false)).toBe('Ventanas privadas: no permitidas');
    expect(state('brave', true)).toBe('Ventanas privadas: permitidas');
    expect(state('chrome', true)).toBe('Incógnito: permitido');
    expect(state('chrome', false)).toBe('Incógnito: no permitido');
    expect(state('edge', false)).toBe('InPrivate: no permitido');
  });

  it('headers never put a capital right after «Cosa:» (sentence case, like the app)', () => {
    expect(PAGES_ES.common.targets.whitelistShort).toBe('solo lista blanca');
    const header = PAGES_ES.popup.block(PAGES_ES.common.targets.whitelistShort, 'Examen');
    expect(header).toBe('Bloqueo: solo lista blanca · Examen');
    for (const level of Object.values(PAGES_ES.common.punishmentLevels)) {
      expect(PAGES_ES.popup.punishment(level)).toMatch(/^Castigo: [a-záéíóúñ]/);
    }
  });

  it("the install guide names each browser's own labels and a way that always works", () => {
    const chromium = PAGES_ES.guide.chromium.steps.join(' ');
    expect(chromium).toContain('«Cargar descomprimida»');
    expect(chromium).toContain('en Edge, «Cargar desempaquetada»');
    expect(chromium).toMatch(/Modo de desarrollador.*en Edge, en el panel de la izquierda/);

    const firefox = [...PAGES_ES.guide.firefox.steps, ...PAGES_ES.guide.firefox.notes].join(' ');
    // A GitHub download is a file: install it from about:addons, not by opening it.
    expect(firefox).toContain('about:addons, pulsa ⚙ › «Instalar complemento desde archivo…»');
    expect(firefox).not.toMatch(/ábrelo con Firefox/);
    // The host permission lives in its own section, not in «the next step».
    expect(firefox).not.toMatch(/siguiente paso/);
    expect(firefox).toContain(`«${PAGES_ES.guide.toc['host-permission']}»`);
    // A release without the signed .xpi still has a way in, and updates are explained.
    expect(firefox).toMatch(/Si la versión no trae \.xpi/);
    expect(firefox).toContain('about:debugging › Este Firefox');
    expect(firefox).toContain('«Cargar complemento temporal…»');
    expect(firefox).toMatch(/Para actualizarla, instala el \.xpi nuevo/);
  });

  it('each install guide names its own package (package.mjs), never the other one', () => {
    const packager = readFileSync(join(import.meta.dirname, '../../package.mjs'), 'utf8');
    const zips = [...packager.matchAll(/'(Centrate-extension[\w-]*\.zip)'/g)].map((m) => m[1]);
    expect(zips).toEqual([
      'Centrate-extension.zip',
      'Centrate-extension-store.zip',
      'Centrate-extension-firefox.zip',
    ]);

    // The Chromium zip carries `"incognito": "split"`, which Firefox reads as «not_allowed»:
    // loaded in Firefox it could never run in private windows (a free way around a block).
    const firefox = [...PAGES_ES.guide.firefox.steps, ...PAGES_ES.guide.firefox.notes].join(' ');
    expect(firefox).toContain('Centrate-extension-firefox.zip');
    expect(firefox).not.toMatch(/Centrate-extension\.zip/);
    const chromium = [...PAGES_ES.guide.chromium.steps, ...PAGES_ES.guide.chromium.notes].join(' ');
    expect(chromium).toContain('Centrate-extension.zip');
    expect(chromium).not.toContain('firefox.zip');
    // The store zip (no `key`, another id) is for store uploads, not for the guides.
    expect(`${firefox} ${chromium}`).not.toContain('store.zip');
  });

  it('the temporary Firefox add-on: gone when Firefox closes, and allowed in private windows', () => {
    const notes = PAGES_ES.guide.firefox.notes.join(' ');
    expect(notes).toMatch(/desaparece al cerrar Firefox/);
    const firefoxPrivate = PAGES_ES.guide.incognito.browsers.find((b) =>
      b.families.includes('firefox'),
    );
    // Same labels as the incognito section and the popup's «Cómo hacerlo…».
    expect(firefoxPrivate?.steps).toContain('«Ejecutar en ventanas privadas»');
    expect(notes).toContain('about:addons › Céntrate');
    expect(notes).toContain('«Ejecutar en ventanas privadas» en «Permitir»');
  });

  it('«Reintentar» says what it is doing and what it found, in es.ts', () => {
    expect(PAGES_ES.popup.retrying).toBe('Reintentando…');
    expect(PAGES_ES.popup.retryStill(true, PAGES_ES.popup.checkedAt('17:42'))).toBe(
      'Sigue sin responder · comprobado a las 17:42',
    );
  });

  it('the privacy note says what leaves the browser: only the blocked domain', () => {
    const note = PAGES_ES.guide.privacy.points.join(' ');
    expect(note).toMatch(/Nunca envía tu historial/);
    expect(note).toMatch(/solo cuando intentas abrir algo bloqueado, envía el dominio/i);
    expect(note).toMatch(/nunca la dirección completa/);
  });
});
