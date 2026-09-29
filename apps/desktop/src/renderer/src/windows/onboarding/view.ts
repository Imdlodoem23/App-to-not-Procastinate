/**
 * View model of the onboarding (PROMPT §9 «Onboarding», §10 «Onboarding»; docs/DESKTOP.md
 * §15.4), pure. The first run shows it in the main window in place of the sections (the footer
 * stays): five steps, each one section «Guardián · paso 2 de 5» · «No instalado» with one
 * sentence, a row of tiles «Instalar | Omitir» and progress dots.
 *
 * 1. Bienvenida: «Empezar | Omitir» (Omitir goes straight to the app).
 * 2. Guardián: «Instalar | Omitir» (the same elevation as «Reparar»); «Continuar» once it answers.
 * 3. Extensión: the pairing code at 32 px and the per-browser guides; «Continuar» once connected.
 * 4. Cámara: what Study Mode will do with it; «Continuar» (its help says the test arrives with
 *    Study Mode). «Probar cámara | Omitir» only with the `study` flag (hidden, never greyed out).
 * 5. Primer bloqueo: «no veo YouTube en 25 minutos» already typed in «¿Qué quieres hacer?»;
 *    «Crear bloqueo» (or Enter) finishes and opens the confirmation card with it.
 *
 * The step lives in `prefs.onboarding` (main persists it, so a restart resumes); the pairing
 * code and «Instalando…» in `main.onboarding` (fixture-settable). Every tile has an Alt + letter
 * that the footer does not use.
 */
import type { Accent } from '@centrate/shared/design/tokens';
import type { PairingCodeResponse } from '@centrate/shared/guardian-api';
import { DEFAULT_GUARDIAN_PORT } from '@centrate/shared/guardian-api';
import { localized } from '../../../../shared/i18n/locale';
import { ONBOARDING_STEPS, type OnboardingStep } from '../../../../shared/prefs';
import {
  onboardingStepNumber,
  onboardingStepStatus,
  type OnboardingLocalState,
  type UiSnapshot,
} from '../../../../shared/ui-state';
import type { HelpTone } from '../../components/tones';
import { ONBOARDING } from './i18n';

const O = ONBOARDING;

export type OnboardingAction =
  | 'start'
  | 'skip'
  | 'install'
  | 'continue'
  | 'guide-chromium'
  | 'guide-firefox'
  | 'camera'
  | 'create';

/**
 * Alt + letter of each tile, per language (the letter is in its label and the footer never uses
 * it: «Mini temporizador | Ajustes… | Salir» are z, a, s in Spanish and m, s, q in English).
 */
export const ONBOARDING_KEYS: Readonly<Record<OnboardingAction | 'repair', string>> = localized<
  Record<OnboardingAction | 'repair', string>
>({
  es: {
    start: 'e',
    skip: 'o',
    install: 'i',
    /** «Reparar»: the install tile while the guardian is installed but stopped. */
    repair: 'r',
    continue: 'c',
    'guide-chromium': 'h',
    'guide-firefox': 'f',
    camera: 'p',
    create: 'b',
  },
  en: {
    start: 't',
    skip: 'k',
    install: 'i',
    repair: 'r',
    continue: 'c',
    'guide-chromium': 'h',
    'guide-firefox': 'f',
    camera: 'e',
    create: 'b',
  },
});

export interface OnboardingTileView {
  id: OnboardingAction;
  label: string;
  help: string;
  mnemonic: string;
  /** Opens something outside the app (the guides): a door tile «…». */
  door: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export type OnboardingPairingView =
  | { kind: 'code'; code: string; expiresAtMs: number; port: string | null }
  /** Expired, or not asked yet: «Nuevo código». */
  | { kind: 'none'; expired: boolean };

export interface OnboardingView {
  step: OnboardingStep;
  /** «Guardián · paso 2 de 5». */
  title: string;
  /** «No instalado», on the right of the header. */
  status: string;
  /** The header datum's tone (a `Section` `datumTone`). */
  statusTone: HelpTone;
  sentence: string;
  /** Step 3 while not connected and the guardian answers (`null` otherwise). */
  pairing: OnboardingPairingView | null;
  /** Step 5: «¿Qué quieres hacer?» with the phrase typed. */
  field: boolean;
  tiles: OnboardingTileView[];
  /** The row's help line when no tile is hovered: the last result, else the first tile's help. */
  help: { text: string; tone: HelpTone };
  dots: ('done' | 'current' | 'todo')[];
}

/** The last answer shown on the row's help line («Instalado: esperando a que responda…»). */
export interface OnboardingResult {
  text: string;
  tone: HelpTone;
}

/** The step after `step`, or `null` after the last one. */
export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[index + 1] ?? null;
}

/** The phrase step 5 leaves typed (PROMPT §10), in the active language. */
export function firstBlockPhrase(): string {
  return O.firstBlockPhrase;
}

function tile(
  id: OnboardingAction,
  label: string,
  help: string,
  extra: Partial<Pick<OnboardingTileView, 'door' | 'disabled' | 'disabledReason'>> = {},
): OnboardingTileView {
  return {
    id,
    label,
    help,
    mnemonic: ONBOARDING_KEYS[id],
    door: extra.door ?? false,
    disabled: extra.disabled ?? false,
    ...(extra.disabledReason !== undefined ? { disabledReason: extra.disabledReason } : {}),
  };
}

function skip(step: OnboardingStep): OnboardingTileView {
  return tile('skip', O.tiles.skip, O.help.skip[step]);
}

function pairingView(pairing: PairingCodeResponse | null, nowMs: number): OnboardingPairingView {
  if (!pairing) return { kind: 'none', expired: false };
  const expiresAtMs = Date.parse(pairing.expiresAt);
  if (!(expiresAtMs > nowMs)) return { kind: 'none', expired: true };
  return {
    kind: 'code',
    code: pairing.code,
    expiresAtMs,
    port: pairing.port === DEFAULT_GUARDIAN_PORT ? null : O.pairing.port(String(pairing.port)),
  };
}

interface StepBody {
  status: string;
  statusTone: Accent | 'muted';
  sentence: string;
  pairing: OnboardingPairingView | null;
  tiles: OnboardingTileView[];
}

function stepBody(
  snapshot: UiSnapshot,
  local: OnboardingLocalState,
  step: OnboardingStep,
  nowMs: number,
): StepBody {
  const S = O.status;
  const done = onboardingStepStatus(snapshot, step) === 'done';
  switch (step) {
    case 'welcome':
      return {
        status: S.welcome,
        statusTone: 'muted',
        sentence: O.sentences.welcome,
        pairing: null,
        tiles: [tile('start', O.tiles.start, O.help.start), skip(step)],
      };
    case 'guardian': {
      if (done) {
        return {
          status: S.guardianDone,
          statusTone: 'green',
          sentence: O.sentences.guardianDone,
          pairing: null,
          tiles: [tile('continue', O.tiles.continue, O.help.continue)],
        };
      }
      const { link } = snapshot;
      const notInstalled = link.status === 'down' && link.reason === 'not_installed';
      const status = local.installing
        ? S.guardianInstalling
        : link.status === 'connecting'
          ? S.guardianChecking
          : notInstalled
            ? S.guardianTodo
            : S.guardianStopped;
      const label = local.installing
        ? O.tiles.installing
        : notInstalled || link.status === 'connecting'
          ? O.tiles.install
          : O.tiles.repair;
      return {
        status,
        statusTone: local.installing || link.status === 'connecting' ? 'muted' : 'red',
        sentence: O.sentences.guardian,
        pairing: null,
        tiles: [
          {
            ...tile('install', label, O.help.install, {
              disabled: local.installing,
              disabledReason: O.help.install,
            }),
            ...(label === O.tiles.repair ? { mnemonic: ONBOARDING_KEYS.repair } : {}),
          },
          skip(step),
        ],
      };
    }
    case 'extension': {
      if (done) {
        return {
          status: S.extensionDone,
          statusTone: 'green',
          sentence: O.sentences.extensionDone,
          pairing: null,
          tiles: [tile('continue', O.tiles.continue, O.help.continue)],
        };
      }
      const guardian = snapshot.link.status === 'ok';
      return {
        status: S.extensionTodo,
        statusTone: 'orange',
        sentence: guardian ? O.sentences.extension : O.sentences.extensionNoGuardian,
        pairing: guardian ? pairingView(local.pairing, nowMs) : null,
        tiles: [
          tile('guide-chromium', O.tiles.guideChromium, O.help.guideChromium, { door: true }),
          tile('guide-firefox', O.tiles.guideFirefox, O.help.guideFirefox, { door: true }),
          skip(step),
        ],
      };
    }
    case 'camera': {
      const available = onboardingStepStatus(snapshot, step) === 'optional';
      return {
        status: available ? S.cameraOptional : S.cameraUnavailable,
        statusTone: 'muted',
        sentence: O.sentences.camera,
        pairing: null,
        tiles: available
          ? [tile('camera', O.tiles.camera, O.help.camera), skip(step)]
          : [tile('continue', O.tiles.continue, O.help.cameraLater)],
      };
    }
    case 'first-block':
      return {
        status: done ? S.firstBlockDone : S.firstBlockTodo,
        statusTone: done ? 'green' : 'muted',
        sentence: O.sentences.firstBlock,
        pairing: null,
        tiles: [tile('create', O.tiles.create, O.help.create), skip(step)],
      };
  }
}

export function deriveOnboardingView(input: {
  snapshot: UiSnapshot;
  local: OnboardingLocalState;
  nowMs: number;
  result: OnboardingResult | null;
}): OnboardingView {
  const { snapshot, local, nowMs, result } = input;
  const step = snapshot.prefs.onboarding.step;
  const number = onboardingStepNumber(step);
  const body = stepBody(snapshot, local, step, nowMs);
  const first = body.tiles[0];
  const fallback = first
    ? first.disabled
      ? (first.disabledReason ?? first.help)
      : first.help
    : '';
  return {
    step,
    title: O.title(O.steps[step], number, ONBOARDING_STEPS.length),
    status: body.status,
    statusTone: body.statusTone === 'neutral' ? 'muted' : body.statusTone,
    sentence: body.sentence,
    pairing: body.pairing,
    field: step === 'first-block',
    tiles: body.tiles,
    help: result ?? { text: fallback, tone: 'muted' },
    dots: ONBOARDING_STEPS.map((_, i) =>
      i + 1 < number ? 'done' : i + 1 === number ? 'current' : 'todo',
    ),
  };
}
