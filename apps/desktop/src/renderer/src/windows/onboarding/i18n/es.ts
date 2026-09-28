/**
 * Spanish strings of the onboarding (PROMPT §9 «Onboarding», §10 «Bandeja y otras superficies ›
 * Onboarding»): five steps, each a section «Guardián · paso 2 de 5» · «No instalado» with one
 * sentence, a row «Instalar | Omitir» and progress dots. `en.ts` has the same shape
 * (`OnboardingMessages`).
 */
import type { InstallOutcome } from '../../../../../shared/platform';
import type { OnboardingStep } from '../../../../../shared/prefs';
import type { Widen } from '../../../../../shared/i18n/locale';

export const ONBOARDING_ES = {
  /** Accessible name of the whole flow (the region around the step). */
  name: 'Primeros pasos',
  /** «Guardián · paso 2 de 5». */
  title: (step: string, n: number, total: number): string => `${step} · paso ${n} de ${total}`,
  steps: {
    welcome: 'Bienvenida',
    guardian: 'Guardián',
    extension: 'Extensión',
    camera: 'Cámara',
    'first-block': 'Primer bloqueo',
  } satisfies Record<OnboardingStep, string>,
  /** The datum on the right of each step's header. */
  status: {
    welcome: 'Unos 2 minutos',
    guardianTodo: 'No instalado',
    guardianStopped: 'Detenido',
    guardianChecking: 'Comprobando…',
    guardianInstalling: 'Instalando…',
    guardianDone: 'Instalado',
    extensionTodo: 'Sin conectar',
    extensionDone: 'Conectada',
    cameraUnavailable: 'Llega con el Study Mode',
    cameraOptional: 'Opcional',
    firstBlockTodo: 'Listo para crear',
    firstBlockDone: 'Creado',
  },
  /** The one sentence of each step. */
  sentences: {
    welcome:
      'Céntrate bloquea lo que te distrae, y el bloqueo aguanta aunque cierres la app o reinicies.',
    guardian:
      'El guardián aplica los bloqueos por su cuenta. Instalarlo pide permiso de administrador una sola vez.',
    guardianDone: 'Instalado: ya aplica los bloqueos aunque cierres la app.',
    extension:
      'La extensión bloquea al instante dentro del navegador. Instálala y escribe en ella este código:',
    extensionNoGuardian:
      'La extensión bloquea al instante dentro del navegador. Para emparejarla hace falta el guardián.',
    extensionDone: 'Conectada: el navegador ya bloquea al instante.',
    camera:
      'El Study Mode usará la cámara para ver si estudias, sin que ninguna imagen salga de tu ordenador.',
    firstBlock:
      'Te dejamos escrito tu primer bloqueo: Enter para revisarlo y otra vez Enter para empezar.',
  },
  /** Step 5 leaves this typed in «¿Qué quieres hacer?» (PROMPT §10). */
  firstBlockPhrase: 'no veo YouTube en 25 minutos',
  fieldLabel: '¿Qué quieres hacer?',
  /** The row of each step. */
  rowLabel: 'Acciones del paso',
  tiles: {
    start: 'Empezar',
    skip: 'Omitir',
    install: 'Instalar',
    repair: 'Reparar',
    installing: 'Instalando…',
    continue: 'Continuar',
    guideChromium: 'Chrome y Edge',
    guideFirefox: 'Firefox',
    camera: 'Probar cámara',
    create: 'Crear bloqueo',
  },
  help: {
    start: 'Guardián, extensión y tu primer bloqueo, en unos 2 minutos',
    install: 'Pide permiso de administrador una sola vez',
    continue: 'Al siguiente paso',
    guideChromium: 'Paso a paso en Chrome, Edge, Brave y otros',
    guideFirefox: 'Paso a paso en Firefox',
    camera: 'La prueba de cámara llega con el Study Mode',
    create: 'Revisa el bloqueo y confírmalo con Enter',
    skip: {
      welcome: 'Directo a la app; puedes repetir estos pasos desde Ajustes',
      guardian: 'Sin guardián no se bloquea nada; puedes instalarlo desde Ajustes',
      extension: 'Puedes emparejarla más tarde desde Ajustes',
      camera: 'La cámara es opcional',
      'first-block': 'Termina sin crear ningún bloqueo',
    } satisfies Record<OnboardingStep, string>,
  },
  /** «Instalar» answers (step 2). */
  install: {
    installed: 'Instalado: esperando a que responda…',
    'already-installed': 'Ya estaba instalado',
    cancelled: 'Sin el permiso de administrador no se puede instalar',
    unsupported: 'Aquí no se puede instalar desde la app: mira la guía de la web',
  } satisfies Record<InstallOutcome, string>,
  /** Step 3's code. */
  pairing: {
    expires: 'Caduca en',
    expired: 'El código ha caducado',
    newCode: 'Nuevo código',
    /** Screen readers: «Código de emparejamiento: 4 8 2 9 1 3». */
    codeLabel: (code: string): string => `Código de emparejamiento: ${code}`,
    port: (port: string): string => `Puerto: ${port}`,
  },
  /** «Probar cámara» (step 4) before Study Mode. */
  cameraUnavailable: 'La prueba de cámara llega con el Study Mode',
  saveFailed: 'No se ha podido guardar: inténtalo otra vez',
} as const;

export type OnboardingMessages = Widen<typeof ONBOARDING_ES>;
