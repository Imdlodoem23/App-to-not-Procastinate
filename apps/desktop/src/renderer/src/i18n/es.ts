/**
 * Spanish strings of the renderer foundation (RENDERER-CORE): window shells, the UI kit,
 * section 1 «Aviso de protección», section 4 «Progreso», section 5 «Pie» and the guardian error
 * copy (docs/DESKTOP.md §7.5). Strings shared with the main process (modes, targets, remaining
 * time, points) live in `src/shared/i18n/es.ts`; section 2 and the detail windows keep their own
 * `i18n/es.ts`. Ready for an `en.ts` with the same shape (`RendererMessages`).
 *
 * Numbers, clock times and the typographic minus come from `src/shared/format.ts` (es-ES,
 * `useGrouping: 'always'`, 24 h): pass already formatted values into the functions below.
 */
import type { BrowserFamily } from '@centrate/shared/domain';
import type { DetailName } from '../../../shared/ui-state';

export const RENDERER_ES = {
  shell: {
    appName: 'Céntrate',
    detailTitles: {
      bloqueos: 'Bloqueos',
      emergencia: 'Emergencia',
      ajustes: 'Ajustes',
    } satisfies Record<DetailName, string>,
    crashed: 'Algo ha fallado en esta ventana',
    crashedHelp: 'Los bloqueos siguen activos. Recarga la ventana para seguir.',
    reload: 'Recargar',
    noBridge: 'Esta ventana solo funciona dentro de Céntrate',
    /** Stand-in while section 2 is not bundled (development only). */
    bloqueoTitle: 'Bloqueo',
    bloqueoUnavailable: 'Esta parte de la ventana aún no está disponible',
  },
  kit: {
    /** In-place confirmation: first press. «¿Seguro? Desbloquear». */
    armed: (label: string): string => `¿Seguro? ${label}`,
    /** Doors end in «…» (added when the label does not already). */
    door: (label: string): string => (label.endsWith('…') ? label : `${label}…`),
    toggleOn: 'Sí',
    toggleOff: 'No',
  },
  protection: {
    guardianStopped: 'Guardián detenido: ahora mismo no se bloquea nada',
    guardianNotInstalled: 'Guardián no instalado: ahora mismo no se bloquea nada',
    guardianOutdated: 'Actualiza el guardián',
    safeMode: 'Guardián en modo seguro: no se pueden crear bloqueos',
    notApplied: 'El bloqueo no se está aplicando del todo',
    /** «Chrome no tiene la extensión: ahí el bloqueo puede tardar». */
    extensionMissing: (browsers: string, plural: boolean): string =>
      plural
        ? `${browsers} no tienen la extensión: ahí el bloqueo puede tardar`
        : `${browsers} no tiene la extensión: ahí el bloqueo puede tardar`,
    browsers: {
      chrome: 'Chrome',
      edge: 'Edge',
      brave: 'Brave',
      opera: 'Opera',
      vivaldi: 'Vivaldi',
      chromium: 'Chromium',
      firefox: 'Firefox',
      other: 'Otro navegador',
    } satisfies Record<BrowserFamily, string>,
    /** «Chrome y Edge», «Chrome, Edge y Brave». */
    and: ' y ',
    rowLabel: 'Qué hacer',
    /** Alt + letter (unique among visible tiles: BLOQUEO avoids p, t, i, a, s, z). */
    mnemonics: { repair: 'p', details: 't', install: 'i' },
    actions: {
      repair: 'Reparar',
      repairing: 'Reparando…',
      install: 'Instalar…',
      details: 'Detalles…',
    },
    help: {
      repair: 'Vuelve a arrancar el guardián (pide permiso de administrador)',
      installGuardian: 'Instala el guardián (pide permiso de administrador una vez)',
      installExtension: 'Abre la guía para instalar la extensión en ese navegador',
      details: 'Estado del guardián y de la extensión, en Ajustes',
    },
  },
  repair: {
    started: 'Hecho: comprobando el guardián…',
    cancelled: 'Has cancelado el permiso de administrador',
    unsupported: 'Aquí no se puede reparar solo: mira Detalles…',
  },
  progreso: {
    /** «Nivel 7 · 1.240 puntos» (`points` already formatted: «1.240 puntos»). */
    title: (level: string, points: string): string => `Nivel ${level} · ${points}`,
    /** «Racha: 5 días», «Racha: 1 día». */
    streak: (days: number, formatted: string): string =>
      days === 1 ? `Racha: ${formatted} día` : `Racha: ${formatted} días`,
    negative: 'Números rojos',
    /** «Hoy: 42 de 60 min». */
    goal: (focus: string, goal: string): string => `Hoy: ${focus} de ${goal} min`,
    /** Accessible name of the goal bar. */
    goalAria: (focus: string, goal: string): string =>
      `Objetivo de hoy: ${focus} de ${goal} minutos concentrado`,
    doorsLabel: 'Tu progreso',
    doors: {
      stats: 'Estadísticas…',
      rewards: 'Recompensas…',
      achievements: 'Logros…',
    },
    doorsHelp: {
      stats: 'Tiempo concentrado por día, semana y mes',
      rewards: 'Canjea tus puntos por descansos ganados',
      achievements: 'Lo que has conseguido y cómo conseguir el resto',
    },
    mascot: {
      sprout: 'Tu brote',
      plant: 'Tu planta',
      tree: 'Tu árbol',
      wilted: 'Tu planta, marchita',
    },
  },
  footer: {
    guardianOk: 'Guardián activo',
    guardianConnecting: 'Conectando con el guardián…',
    guardianUnresponsive: 'Guardián sin respuesta',
    guardianStopped: 'Guardián detenido',
    guardianNotInstalled: 'Guardián no instalado',
    guardianOutdated: 'Guardián desactualizado',
    extensionOk: 'Extensión conectada',
    extensionDisconnected: 'Extensión desconectada',
    extensionMissing: 'Sin extensión',
    separator: '·',
    repair: 'Reparar',
    install: 'Instalar…',
    /** «v1.2.0». */
    version: (version: string): string => `v${version}`,
    /** «Actualizar a v1.3.0». */
    update: (version: string): string => `Actualizar a v${version}`,
    updateHelp: 'Hay una versión nueva de Céntrate',
    status: 'Estado de la protección',
    rowLabel: 'Acciones de la app',
    mnemonics: { miniTimer: 'z', settings: 'a', quit: 's' },
    buttons: {
      miniTimer: 'Mini temporizador',
      settings: 'Ajustes…',
      quit: 'Salir',
    },
    help: {
      miniTimer: 'Un reloj pequeño, siempre visible, que puedes mover',
      settings: 'Tema, arranque, modo por defecto, guardián, extensión y datos',
      quit: 'Los bloqueos siguen activos aunque salgas',
    },
  },
  errors: {
    unresponsive: 'El guardián no responde',
    notInstalled: 'El guardián no está instalado',
    outdated: 'Actualiza el guardián',
    readOnly: 'El guardián solo puede leer ahora mismo',
    extensionExceedsMax: 'Como mucho 24 h en total',
    blockNotActive: 'El bloqueo ya terminó',
    notExtendable: 'Un castigo no se puede ampliar',
    durationOutOfRange: 'Entre 5 min y 24 h',
    tooManyTargets: 'Demasiados bloqueos activos a la vez',
    protectedTarget: 'Eso no se puede bloquear: el sistema lo necesita',
    unknownId: 'Actualiza el guardián: no conoce ese servicio',
    phraseMismatch: 'La frase no coincide',
    confirmWordMismatch: 'Escribe BORRAR',
    emergencyNotReady: 'Aún no: espera a que acabe la cuenta atrás',
    emergencyExpired: 'Se pasó el plazo: pide la emergencia otra vez',
    emergencyInProgress: 'Ya hay una emergencia en marcha',
    emergencyNotAvailable: 'Ese bloqueo no admite emergencia',
    emergencyMoot: 'Los bloqueos ya terminaron: no se ha cobrado nada',
    dataDeleteBlocked: 'Ahora no se puede borrar',
    dataDeleteReasons: {
      study_active: 'hay un Study Mode en marcha',
      emergency_pending: 'hay una emergencia en marcha',
      clock_unverified: 'el guardián aún está comprobando la hora',
    } as Record<string, string>,
    /** «Ahora no se puede borrar: hay un Study Mode en marcha». */
    withReason: (text: string, reason: string): string => `${text}: ${reason}`,
    rateLimited: 'Demasiados intentos: espera un momento',
    generic: 'Algo ha fallado en el guardián',
    actions: {
      retry: 'Reintentar',
      repair: 'Reparar',
      details: 'Detalles…',
      edit: 'Editar…',
    },
  },
} as const;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : { [K in keyof T]: Widen<T[K]> };

/** Shape every renderer language file must match. */
export type RendererMessages = Widen<typeof RENDERER_ES>;
