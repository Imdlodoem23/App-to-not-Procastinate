/**
 * What `profile.json` stores, as the privacy texts say it (README «Privacidad», HANDOFF §5,
 * and from them PRIVACY.md, the web and the consent screen). A new stored column or a new
 * limit fails here until the texts are updated.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIP_MAX_ROWS,
  PROFILE_MAX_BYTES,
  PROFILE_MAX_ROWS,
} from '../../src/calibration/constants';
import { STUDY_AI_CONSTANTS } from '../../src/config';
import { FEATURE_ROW_COLUMNS } from '../../src/types';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each stored column and the words the README uses for it. */
const DOCUMENTED: Readonly<Record<(typeof FEATURE_ROW_COLUMNS)[number], readonly string[]>> = {
  face: ['si hay cara'],
  yaw: ['ángulos de la cabeza'],
  pitch: ['ángulos de la cabeza'],
  roll: ['ángulos de la cabeza'],
  cx: ['posición', 'de la cara en la imagen'],
  cy: ['posición', 'de la cara en la imagen'],
  w: ['tamaño de la cara'],
  h: ['tamaño de la cara'],
  truncated: ['cortada por el borde'],
  blink: ['parpadeo'],
  lookDown: ['la mirada', 'hacia abajo'],
  lookUp: ['la mirada', 'hacia arriba'],
  gazeX: ['la mirada', 'a los lados'],
  jawOpen: ['abres la boca'],
  phone: ['un móvil'],
  phoneNear: ['cerca de la cara'],
  phoneMoving: ['se mueve'],
  book: ['un libro'],
  person: ['una persona'],
  lumaMean: ['el brillo'],
  lumaStd: ['el contraste'],
  quality: ['la calidad de la imagen'],
};

/** The text under `heading` up to the next heading, with whitespace runs as one space. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf('\n#', start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
}

describe('privacy texts match what profile.json stores', () => {
  const readme = section(readFileSync(join(PKG, 'README.md'), 'utf8'), '### Privacidad');
  const handoff = section(readFileSync(join(PKG, 'HANDOFF.md'), 'utf8'), '## 5. Persistence');

  it('names every stored column', () => {
    expect(Object.keys(DOCUMENTED)).toEqual([...FEATURE_ROW_COLUMNS]);
    expect(readme).toContain(`${FEATURE_ROW_COLUMNS.length} números`);
    expect(handoff).toContain(`${FEATURE_ROW_COLUMNS.length} \`FEATURE_ROW_COLUMNS\``);
    for (const [column, words] of Object.entries(DOCUMENTED)) {
      for (const w of words) expect(readme, `${column}: «${w}»`).toContain(w);
    }
  });

  it('states the limits and the «¡Estaba estudiando!» rows', () => {
    const c = STUDY_AI_CONSTANTS;
    for (const text of [readme, handoff]) {
      expect(text).toContain(`${CLIP_MAX_ROWS} `);
      expect(text).toContain(`${c.feedbackRowsPerClass} `);
      expect(text).toContain(`${c.feedbackMaxFrames} `);
      expect(text).toContain(`${PROFILE_MAX_BYTES / 1024} KB`);
      expect(text).toContain('«¡Estaba estudiando!»');
      expect(text).toContain('«Recalibrar»');
    }
    expect(readme).toContain(`${PROFILE_MAX_ROWS} filas`);
    expect(handoff).toContain(`${PROFILE_MAX_ROWS.toLocaleString('en').replace(',', ' ')} rows`);
    expect(readme).toContain('«Borrar todos mis datos»');
    expect(readme).not.toContain('números de la calibración');
    expect(handoff).not.toContain('calibration numbers');
  });
});
