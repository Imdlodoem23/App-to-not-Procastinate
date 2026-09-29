import { describe, expect, it } from 'vitest';
import { parseIntent } from '@centrate/shared/parser';
import { FEATURES } from '../../../src/shared/features';
import { HARNESS_NOW, harnessFixture, type HarnessStateId } from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { ONBOARDING_STEPS } from '../../../src/shared/prefs';
import { RENDERER } from '../../../src/renderer/src/i18n/messages';
import { duplicateKeys } from '../../../src/renderer/src/windows/bloqueos/mnemonics';
import {
  ONBOARDING_KEYS,
  deriveOnboardingView,
  firstBlockPhrase,
  nextStep,
  type OnboardingView,
} from '../../../src/renderer/src/windows/onboarding/view';
import { draftFromParse, onboardingActive } from '../../../src/shared/ui-state';

const NOW = HARNESS_NOW;

function viewOf(
  id: HarnessStateId,
  patch: (f: ReturnType<typeof harnessFixture>) => void = () => undefined,
): OnboardingView {
  const fixture = harnessFixture(id);
  patch(fixture);
  return deriveOnboardingView({
    snapshot: fixture.snapshot,
    local: fixture.main.onboarding,
    nowMs: NOW,
    result: null,
  });
}

function tiles(view: OnboardingView): [string, string][] {
  return view.tiles.map((t) => [t.label, t.mnemonic]);
}

describe('Onboarding fixtures', () => {
  it('shows only on the onboarding fixtures', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(onboardingActive(harnessFixture(`onboarding-${n}` as HarnessStateId).snapshot)).toBe(
        true,
      );
    }
    expect(onboardingActive(harnessFixture('idle').snapshot)).toBe(false);
    expect(onboardingActive(harnessFixture('ajustes-full').snapshot)).toBe(false);
  });

  it('1: welcome · «Empezar | Omitir»', () => {
    const view = viewOf('onboarding-1');
    expect(view.title).toBe('Bienvenida · paso 1 de 5');
    expect(view.status).toBe('Unos 2 minutos');
    expect(view.sentence).toMatch(/^Céntrate bloquea lo que te distrae/);
    expect(tiles(view)).toEqual([
      ['Empezar', 'e'],
      ['Omitir', 'o'],
    ]);
    expect(view.help).toEqual({
      text: 'Guardián, extensión y tu primer bloqueo, en unos 2 minutos',
      tone: 'muted',
    });
    expect(view.dots).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(view.pairing).toBeNull();
    expect(view.field).toBe(false);
  });

  it('2: guardian «No instalado» · «Instalar | Omitir»', () => {
    const view = viewOf('onboarding-2');
    expect(view.title).toBe('Guardián · paso 2 de 5');
    expect([view.status, view.statusTone]).toEqual(['No instalado', 'red']);
    expect(tiles(view)).toEqual([
      ['Instalar', 'i'],
      ['Omitir', 'o'],
    ]);
    expect(view.dots).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
  });

  it('2: «Instalando…» while the elevation prompt is up, «Continuar» once it answers', () => {
    const installing = viewOf('onboarding-2', (f) => {
      f.main.onboarding.installing = true;
    });
    expect(installing.status).toBe('Instalando…');
    expect(installing.tiles[0]).toMatchObject({ label: 'Instalando…', disabled: true });
    const stopped = viewOf('onboarding-2', (f) => {
      f.snapshot.link = { ...f.snapshot.link, status: 'down', reason: 'unreachable' };
    });
    expect([stopped.status, stopped.tiles[0]?.label, stopped.tiles[0]?.mnemonic]).toEqual([
      'Detenido',
      'Reparar',
      'r',
    ]);
    const done = viewOf('onboarding-1', (f) => {
      f.snapshot.prefs.onboarding.step = 'guardian';
    });
    expect([done.status, done.statusTone]).toEqual(['Instalado', 'green']);
    expect(tiles(done)).toEqual([['Continuar', 'c']]);
  });

  it('3: extension with the pairing code at 32 px and the guides', () => {
    const view = viewOf('onboarding-3');
    expect(view.title).toBe('Extensión · paso 3 de 5');
    expect([view.status, view.statusTone]).toEqual(['Sin conectar', 'orange']);
    expect(view.pairing).toEqual({
      kind: 'code',
      code: '482913',
      expiresAtMs: NOW + 4 * 60_000 + 20_000,
      port: null,
    });
    expect(view.tiles.map((t) => [t.label, t.door, t.mnemonic])).toEqual([
      ['Chrome y Edge', true, 'h'],
      ['Firefox', true, 'f'],
      ['Omitir', false, 'o'],
    ]);
    const expired = deriveOnboardingView({
      snapshot: harnessFixture('onboarding-3').snapshot,
      local: harnessFixture('onboarding-3').main.onboarding,
      nowMs: NOW + 5 * 60_000,
      result: null,
    });
    expect(expired.pairing).toEqual({ kind: 'none', expired: true });
    const noGuardian = viewOf('onboarding-3', (f) => {
      f.snapshot.link = { ...f.snapshot.link, status: 'down', reason: 'not_installed' };
    });
    expect(noGuardian.pairing).toBeNull();
    expect(noGuardian.sentence).toMatch(/hace falta el guardián/);
    const connected = viewOf('onboarding-1', (f) => {
      f.snapshot.prefs.onboarding.step = 'extension';
    });
    expect([connected.status, connected.tiles.map((t) => t.label)]).toEqual([
      'Conectada',
      ['Continuar'],
    ]);
  });

  it('4: the camera arrives with Study Mode: «Continuar», nothing greyed out', () => {
    const view = viewOf('onboarding-4');
    expect(view.title).toBe('Cámara · paso 4 de 5');
    expect(view.status).toBe('Llega con el Study Mode');
    expect(view.sentence).toMatch(/ninguna imagen salga de tu ordenador/);
    expect(tiles(view)).toEqual([['Continuar', 'c']]);
    expect(view.tiles.some((t) => t.disabled)).toBe(false);
    expect(view.help.text).toBe('La prueba de cámara llega con el Study Mode');
    const study = viewOf('onboarding-4', (f) => {
      f.snapshot.features = { ...FEATURES, study: true };
    });
    expect(study.status).toBe('Opcional');
    expect(tiles(study)).toEqual([
      ['Probar cámara', 'p'],
      ['Omitir', 'o'],
    ]);
    expect(study.tiles[0]?.disabled).toBe(false);
    expect(study.help.text).toBe('Comprueba que la cámara te ve');
  });

  it('5: the first block, already typed', () => {
    const fixture = harnessFixture('onboarding-5');
    expect(fixture.main.composer.text).toBe(firstBlockPhrase());
    const view = viewOf('onboarding-5');
    expect(view.title).toBe('Primer bloqueo · paso 5 de 5');
    expect(view.field).toBe(true);
    expect(tiles(view)).toEqual([
      ['Crear bloqueo', 'b'],
      ['Omitir', 'o'],
    ]);
    expect(view.dots).toEqual(['done', 'done', 'done', 'done', 'current']);
  });

  it('shows the last answer on the help line', () => {
    const fixture = harnessFixture('onboarding-2');
    const view = deriveOnboardingView({
      snapshot: fixture.snapshot,
      local: fixture.main.onboarding,
      nowMs: NOW,
      result: { text: 'Sin el permiso de administrador no se puede instalar', tone: 'red' },
    });
    expect(view.help).toEqual({
      text: 'Sin el permiso de administrador no se puede instalar',
      tone: 'red',
    });
  });
});

describe('Onboarding steps and copy', () => {
  it('walks the five steps in order', () => {
    expect(ONBOARDING_STEPS.map(nextStep)).toEqual([
      'guardian',
      'extension',
      'camera',
      'first-block',
      null,
    ]);
  });

  it('leaves a phrase the parser fully understands (25 min of YouTube), in both languages', () => {
    for (const locale of ['es', 'en'] as const) {
      const phrase = withLocale(locale, firstBlockPhrase);
      const parse = parseIntent(phrase, { now: new Date(NOW) });
      const draft = draftFromParse(parse, harnessFixture('onboarding-5').snapshot.prefs);
      expect(draft, `${locale}: ${phrase}`).not.toBeNull();
      expect(draft?.targets.serviceIds).toEqual(['youtube']);
      expect(draft?.end).toEqual({ kind: 'duration', minutes: 25 });
    }
    expect(withLocale('es', firstBlockPhrase)).toBe('no veo YouTube en 25 minutos');
  });

  it('gives each tile a letter of its label that the footer does not use', () => {
    for (const locale of ['es', 'en'] as const) {
      withLocale(locale, () => {
        const footer = Object.values(RENDERER.footer.mnemonics);
        const all = ONBOARDING_STEPS.flatMap(
          (step) =>
            viewOf('onboarding-1', (f) => {
              f.snapshot.prefs.onboarding.step = step;
            }).tiles,
        );
        for (const tile of all) {
          expect(tile.label.toLowerCase(), `${locale}: ${tile.label}`).toContain(tile.mnemonic);
          expect(footer, `${locale}: ${tile.label}`).not.toContain(tile.mnemonic);
        }
        for (const step of ONBOARDING_STEPS) {
          const keys = viewOf('onboarding-1', (f) => {
            f.snapshot.prefs.onboarding.step = step;
          }).tiles.map((t) => t.mnemonic);
          expect(duplicateKeys([...keys, ...footer]), `${locale}: ${step}`).toEqual([]);
        }
        expect(new Set(Object.values(ONBOARDING_KEYS)).size).toBe(
          Object.values(ONBOARDING_KEYS).length,
        );
      });
    }
  });

  it('says English in English', () => {
    const view = withLocale('en', () => viewOf('onboarding-2'));
    expect(view.title).toBe('Guardian · step 2 of 5');
    expect(view.status).toBe('Not installed');
    expect(view.tiles.map((t) => [t.label, t.mnemonic])).toEqual([
      ['Install', 'i'],
      ['Skip', 'k'],
    ]);
  });
});
