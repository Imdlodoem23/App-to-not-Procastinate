/**
 * Spanish strings of the Bloqueos window (PROMPT §4 «Formulario avanzado», §9 «Horarios» and
 * «Modo examen», §10 «Ventanas de detalle › Bloqueos»). Mode names, target lists and points
 * come from `src/shared/format.ts`; numbers and clock times are formatted before they get here.
 * Ready for an `en.ts` with the same shape (`BloqueosMessages`).
 */
import type { BlockMode } from '@centrate/shared/domain';
import type { DraftProblem } from '../../../../../shared/ui-state';

export const BLOQUEOS_ES = {
  /** Line above the form when it was opened from a phrase the parser did not fully get. */
  seed: (phrase: string): string => `De tu frase «${phrase}»: completa lo que falta`,

  targets: {
    /** «Qué bloquear: YouTube, Instagram +2». */
    title: (label: string): string => `Qué bloquear: ${label}`,
    titleNone: 'Qué bloquear: nada aún',
    titleWhitelist: 'Qué bloquear: todo salvo la lista blanca',
    count: (n: number): string => (n === 1 ? '1 elegido' : `${n} elegidos`),
    searchLabel: 'Buscar en el catálogo',
    searchPlaceholder: 'Buscar: YouTube, redes, juegos…',
    noResults: 'No está en el catálogo: si es una web, añádela en «Dominios propios»',
    groupsLabel: 'Categorías del catálogo',
    /** Toggle of a collapsed group: «Ver 9 servicios». */
    show: (n: number): string => (n === 1 ? 'Ver 1 servicio' : `Ver ${n} servicios`),
    hide: 'Ocultar',
    otros: 'Otros',
    otrosNote: 'solo si los eliges',
    /** A service already covered by a checked category. */
    includedIn: (category: string): string => `Ya lo bloquea «${category}»`,
    domains: {
      label: 'Dominios propios',
      placeholder: 'ejemplo.com',
      add: 'Añadir',
      invalid: 'Eso no parece una web: prueba con ejemplo.com',
      protected: 'Eso no se puede bloquear: el sistema lo necesita',
      duplicate: 'Ya está en la lista',
      max: (n: number): string => `Como mucho ${n} dominios`,
      /** «youtube.com es de YouTube: marcado en el catálogo». */
      catalog: (domain: string, service: string): string =>
        `${domain} es de ${service}: marcado en el catálogo`,
      help: 'Webs que no están en el catálogo',
    },
    apps: {
      label: 'Apps del ordenador',
      placeholder: 'Discord, steam.exe…',
      add: 'Añadir',
      invalid: 'Escribe el nombre del programa, por ejemplo steam.exe',
      protected: 'Eso no se puede bloquear: el sistema lo necesita',
      duplicate: 'Ya está en la lista',
      max: (n: number): string => `Como mucho ${n} apps`,
      suggestions: 'Sugerencias',
      suggestionsLabel: 'Apps que coinciden',
      help: 'Se cierran si las abres durante el bloqueo',
    },
    /** Removable entries («marca.com», «steam.exe»). */
    remove: (what: string): string => `Quitar ${what}`,
    removeHelp: 'Pulsa una ficha para quitarla',
    whitelistIntro: 'Examen bloquea todas las webs y apps salvo las de estudio:',
    /** «Google Classroom · Moodle · Wikipedia y 12 más». */
    whitelistList: (names: string, more: number): string =>
      more > 0 ? `${names} y ${more} más` : names,
  },

  duration: {
    /** «Duración: 1 h 30 min». */
    title: (label: string): string => `Duración: ${label}`,
    presetsLabel: 'Duración',
    /** Help of a preset tile: «1 h: hasta las 18:00». */
    presetHelp: (label: string, until: string): string => `${label}: ${until}`,
    minutesLabel: 'Duración',
    minutesPlaceholder: '45 min, 2 h, 1h30…',
    untilLabel: 'Hasta las',
    untilPlaceholder: 'HH:MM',
    help: 'De 5 min a 24 h, o hasta una hora concreta',
    invalidMinutes: 'Escribe cuánto: 45 min, 2 h, 1h30…',
    invalidUntil: 'Escribe la hora así: 18:30',
    tooShort: 'Como mínimo 5 min',
    tooLong: 'Como mucho 24 h',
  },

  mode: {
    /** «Modo: Estricto». */
    title: (mode: string): string => `Modo: ${mode}`,
    rowLabel: 'Modo',
    datum: {
      normal: 'emergencia: 10 min',
      strict: 'emergencia: 30 min',
      hardcore: 'sin emergencia',
      exam: 'sin emergencia',
    } satisfies Record<BlockMode, string>,
    help: {
      normal: 'Normal: la emergencia tarda 10 min y cuesta al menos 200 puntos',
      strict: 'Estricto: la emergencia tarda 30 min y cuesta al menos 200 puntos',
      hardcore: 'Hardcore: no se puede cancelar de ninguna forma',
      exam: 'Examen: solo webs y apps de estudio, y no se puede cancelar',
    } satisfies Record<BlockMode, string>,
  },

  reason: {
    title: 'Tu motivo',
    datum: 'sale cuando intentes entrar',
    label: 'Tu motivo (opcional)',
    placeholder: 'Quiero aprobar mates',
  },

  actions: {
    rowLabel: 'Guardar o bloquear',
    save: 'Guardar como plantilla',
    saveHelp: 'Queda con tus plantillas para usarla con un clic',
    block: 'Bloquear',
    blockHelp: 'Lo confirmas en la ventana principal: solo se puede ampliar, nunca acortar',
    problem: {
      no_targets: 'Elige qué bloquear',
      too_short: 'Como mínimo 5 min',
      too_long: 'Como mucho 24 h',
    } satisfies Record<DraftProblem, string>,
    sent: 'Confírmalo en la ventana principal',
    nameLabel: 'Nombre de la plantilla',
    nameRowLabel: 'Guardar la plantilla',
    saveName: 'Guardar',
    saveNameHelp: 'Guarda la plantilla con este nombre',
    cancel: 'Cancelar',
    cancelHelp: 'Vuelve al formulario sin guardar',
    nameEmpty: 'Ponle un nombre',
    nameLong: (max: number): string => `Como mucho ${max} letras`,
    saved: (label: string): string => `Guardada: «${label}»`,
    full: 'Ya tienes 30 plantillas: borra alguna antes',
  },

  active: {
    title: (n: number): string =>
      n === 0 ? 'Activos: ninguno' : n === 1 ? 'Activos: 1 bloqueo' : `Activos: ${n} bloqueos`,
    /** «YouTube, Instagram · Estricto». */
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    punishment: 'Castigo',
    /** «hasta las 17:42». */
    until: (when: string): string => `hasta ${when}`,
    empty: 'Ahora mismo no hay nada bloqueado',
    emergency: 'Desbloqueo de emergencia…',
    listLabel: 'Bloqueos activos',
  },

  templates: {
    title: (n: number): string => `Plantillas: ${n}`,
    /** «Redes sociales, Vídeo y streaming +2 · 1 h · Normal». */
    desc: (targets: string, duration: string, mode: string): string =>
      `${targets} · ${duration} · ${mode}`,
    defaultMode: 'modo por defecto',
    builtin: 'de serie',
    use: 'Usar',
    useHelp: 'La carga en el formulario de arriba',
    remove: 'Borrar',
    removeConsequence: (label: string): string => `Se borra «${label}» para siempre`,
    rowLabel: (label: string): string => `Plantilla ${label}`,
  },

  schedules: {
    title: (on: number, total: number): string =>
      total === 0 ? 'Horarios: ninguno' : `Horarios: ${on} de ${total} activos`,
    loading: 'Horarios: cargando…',
    unavailable: 'Horarios: sin conexión',
    /** «Próximo: 18:00», «Próximo: mañana 16:00». */
    next: (when: string): string => `Próximo: ${when}`,
    /** «L–V 18:00–20:00 · Redes sociales». */
    row: (days: string, start: string, end: string, targets: string): string =>
      `${days} ${start}–${end} · ${targets}`,
    /** «Tardes de estudio · Normal». */
    desc: (name: string, mode: string): string => (name ? `${name} · ${mode}` : mode),
    running: 'En curso: podrás cambiarlo cuando acabe',
    frozen: 'Empieza en menos de 10 min: ya no se puede quitar',
    saving: 'Guardando…',
    empty: 'Aún no tienes horarios',
    retry: 'Reintentar',
    days: ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as readonly string[],
    everyDay: 'Todos los días',
    range: (a: string, b: string): string => `${a}–${b}`,
    daySeparator: ', ',
  },

  exam: {
    title: 'Modo examen: lista blanca + Hardcore',
    datum: 'no se puede cancelar',
    rowLabel: 'Empezar un examen',
    /** «Examen 2 h». */
    tile: (duration: string): string => `Examen ${duration}`,
    tileHelp: (duration: string): string =>
      `Todo salvo la lista blanca durante ${duration}: lo confirmas en la ventana principal`,
    rowHelp: 'Un clic abre la confirmación en la ventana principal',
    customize: 'Personalizar',
    customizeHelp: 'Prepara el examen en el formulario de arriba',
  },

  /** Clock phrases: «hasta las 18:00», «hasta mañana a las 08:00». */
  until: {
    today: (time: string): string => `hasta las ${time}`,
    tomorrow: (time: string): string => `hasta mañana a las ${time}`,
    weekday: (day: string, time: string): string => `hasta el ${day} a las ${time}`,
  },
  /** «18:00», «mañana 16:00», «jue 16:00». */
  when: {
    tomorrow: (time: string): string => `mañana ${time}`,
    weekday: (day: string, time: string): string => `${day} ${time}`,
  },
} as const;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { [K in keyof T]: Widen<T[K]> };

/** Shape every language file of the window must match. */
export type BloqueosMessages = Widen<typeof BLOQUEOS_ES>;
