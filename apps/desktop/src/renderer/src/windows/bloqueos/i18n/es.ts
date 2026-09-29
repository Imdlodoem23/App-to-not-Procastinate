/**
 * Spanish strings of the Bloqueos window (PROMPT §4 «Formulario avanzado», §9 «Horarios» and
 * «Modo examen», §10 «Ventanas de detalle › Bloqueos»). Mode names, target lists and points
 * come from `src/shared/format.ts`; numbers and clock times are formatted before they get here.
 * `en.ts` has the same shape (`BloqueosMessages`).
 */
import type { BlockMode } from '@centrate/shared/domain';
import type { DraftProblem } from '../../../../../shared/ui-state';
import type { Widen } from '../../../../../shared/i18n/locale';

/** Why «Bloquear…» is disabled (`FormProblem` in `../view.ts`). */
type FormProblemKey = DraftProblem | 'no_duration';

export const BLOQUEOS_ES = {
  /** Line above the form when it was opened from a phrase the parser did not fully get. */
  seed: (phrase: string): string => `De tu frase «${phrase}»: completa lo que falta`,

  targets: {
    /** «Qué bloquear: YouTube +2». */
    title: (label: string): string => `Qué bloquear: ${label}`,
    titleNone: 'Qué bloquear: nada aún',
    titleWhitelist: 'Qué bloquear: todo salvo la lista blanca',
    /** Screen readers, after typing in the search box (debounced). */
    results: (n: number): string =>
      n === 0 ? 'Sin resultados' : n === 1 ? '1 resultado' : `${n} resultados`,
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
    /** Opened from a phrase whose time was not understood: nothing is invented (PROMPT §4). */
    titleOpen: 'Duración: sin elegir',
    /** Header datum: «hasta 18:00», «hasta mañana 08:00». */
    datum: (when: string): string => `hasta ${when}`,
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
      no_duration: 'Elige cuánto dura',
      too_short: 'Como mínimo 5 min',
      too_long: 'Como mucho 24 h',
    } satisfies Record<FormProblemKey, string>,
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
    /** A schedule without days yet (the editor, before the user picks one). */
    noDays: 'sin días',
    /** The row being edited below the list. */
    editing: 'Editando…',
    listLabel: 'Tus horarios',
    /** «Horario L–V 18:00–20:00 · Redes sociales»: the group of a row's controls. */
    rowLabel: (title: string): string => `Horario ${title}`,
    newSchedule: 'Nuevo horario',
    newScheduleHelp: 'Un bloqueo que se repite solo: días, horas y qué bloquear',
    edit: 'Editar',
    editHelp: 'Cambia los días, las horas o lo que bloquea',
    switchHelp: 'Apagado, no se aplica',

    editor: {
      /** «Nuevo horario: L–V 16:00–19:00 · Redes sociales». */
      titleNew: (summary: string): string => `Nuevo horario: ${summary}`,
      titleEdit: (summary: string): string => `Editar: ${summary}`,
      name: 'Nombre',
      nameLabel: 'Nombre del horario (opcional)',
      reason: 'Tu motivo',
      reasonLabel: 'Tu motivo (opcional)',
      reasonPlaceholder: 'Tardes para estudiar',
      days: 'Días',
      dayNames: [
        'lunes',
        'martes',
        'miércoles',
        'jueves',
        'viernes',
        'sábado',
        'domingo',
      ] as readonly string[],
      start: 'Desde',
      end: 'Hasta',
      startPlaceholder: '16:00',
      endPlaceholder: '19:00',
      /** «Dura 3 h». */
      window: (duration: string): string => `Dura ${duration}`,
      windowOvernight: (duration: string): string => `Dura ${duration}: acaba al día siguiente`,
      timesHelp: 'Escribe la hora así: 16:00',
      targets: 'Qué bloquear',
      categoriesLabel: 'Categorías que bloquea',
      extrasLabel: 'También bloquea',
      removeTarget: (what: string): string => `Quitar ${what}`,
      fromForm: 'Añadir lo del formulario de arriba',
      whitelist: 'Examen: todas las webs y apps salvo tu lista blanca',
      mode: 'Modo',
      rowLabel: 'Guardar el horario',
      save: 'Guardar',
      saveHelp: 'El guardián lo aplica cada semana, aunque la app esté cerrada',
      saving: 'Guardando…',
      remove: 'Borrar',
      removeHelp: 'Lo borra; si ya empezó, ese bloqueo sigue hasta el final',
      removeConsequence: (name: string): string =>
        `Se borra «${name}»; lo que ya empezó sigue hasta el final`,
      cancel: 'Cancelar',
      cancelHelp: 'Cierra sin guardar',
      /** Hardcore and Examen: the in-place «¿Seguro?» of «Guardar», in red. */
      consequence: {
        hardcore: 'Cuando empiece, no podrás cancelarlo de ninguna forma hasta que acabe',
        exam: 'Cuando empiece, solo webs y apps de estudio, sin poder cancelarlo hasta que acabe',
      },
      problem: {
        noDays: 'Elige al menos un día',
        badStart: 'Escribe la hora de inicio así: 16:00',
        badEnd: 'Escribe la hora de fin así: 19:00',
        sameTime: 'El inicio y el fin no pueden ser la misma hora',
        tooShort: 'Como mínimo 5 min',
        noTargets: 'Elige qué bloquear',
        nameLong: (max: number): string => `El nombre, como mucho ${max} letras`,
        running: 'En curso: podrás cambiarlo cuando acabe',
        /** 409 `schedule_starting_soon` on an edit: only strengthening goes through. */
        startingSoon: (time: string): string =>
          `Empieza a las ${time}: a menos de 10 min solo se puede endurecer`,
        startingSoonDelete: (time: string): string =>
          `Empieza a las ${time}: a menos de 10 min ya no se puede borrar`,
        full: (max: number): string => `Ya tienes ${max} horarios: borra alguno antes`,
      },
      errors: {
        /** 409 `schedule_in_progress`: «En curso hasta las 19:00: …». */
        inProgress: (until: string): string => `En curso ${until}: podrás cambiarlo cuando acabe`,
        tooMany: 'Tus horarios ya tienen demasiadas webs propias',
        timezone: 'La zona horaria del sistema no es válida',
        notFound: 'Ese horario ya no existe',
        invalid: 'El guardián no acepta este horario: revisa los días y las horas',
      },
      saved: (summary: string): string => `Guardado: ${summary}`,
      removed: (name: string): string => `Borrado: «${name}»`,
    },
  },

  /** «Límites diarios» (ARCHITECTURE §5.10): «YouTube máximo 30 minutos al día». */
  limits: {
    /** «Límites diarios: 3». */
    title: (count: number): string =>
      count === 0 ? 'Límites diarios: ninguno' : `Límites diarios: ${count}`,
    loading: 'Límites diarios: cargando…',
    unavailable: 'Límites diarios: sin conexión',
    /** A guardian without daily limits (an older version). */
    unsupported: 'Tu guardián aún no tiene límites diarios: actualiza Céntrate',
    /** «1 agotado hoy». */
    datum: (reached: number): string => (reached === 0 ? '' : `${reached} agotado hoy`),
    empty: 'Aún no tienes límites. Prueba a escribir «YouTube máximo 30 minutos al día»',
    retry: 'Reintentar',
    listLabel: 'Tus límites diarios',
    /** «YouTube · 30 min al día». */
    row: (name: string, perDay: string): string => `${name} · ${perDay}`,
    /** «30 min al día · entre semana · Estricto» (the row's description when it applies). */
    desc: (days: string, mode: string): string => `${days} · ${mode}`,
    /** The progress bar's accessible name: «Uso de hoy de YouTube». */
    usageLabel: (name: string): string => `Uso de hoy de ${name}`,
    notToday: 'Hoy no cuenta para bloquear',
    disabled: 'Desactivado',
    /** «Cambio pendiente: 1 h al día desde mañana 17:00». */
    pending: (what: string, when: string): string => `Cambio pendiente: ${what} desde ${when}`,
    pendingDelete: (when: string): string => `Se borrará ${when}; hasta entonces sigue contando`,
    /** What a pending change does, shortest first: «1 h al día», «otros días», «menos cosas». */
    pendingWhat: {
      minutes: (perDay: string): string => perDay,
      days: (days: string): string => days,
      mode: (mode: string): string => `modo ${mode}`,
      targets: 'menos cosas',
      disabled: 'desactivado',
      other: 'cambios',
    },
    editing: 'Editando…',
    saving: 'Guardando…',
    edit: 'Editar',
    editHelp: 'Cambia los minutos, los días o lo que limita',
    cancelChange: 'Cancelar cambio',
    cancelChangeHelp: 'Deja el límite como está ahora',
    cancelled: (name: string): string => `Cambio cancelado: ${name}`,
    newLimit: 'Nuevo límite',
    newLimitHelp: 'Unos minutos al día y, al gastarlos, bloqueado hasta medianoche',

    editor: {
      /** «Nuevo límite: Instagram · 45 min al día». */
      titleNew: (summary: string): string => `Nuevo límite: ${summary}`,
      titleEdit: (summary: string): string => `Editar: ${summary}`,
      name: 'Nombre',
      nameLabel: 'Nombre del límite (opcional)',
      minutes: 'Minutos al día',
      minutesLabel: 'Minutos al día',
      minutesPlaceholder: '30, 45 min, 1 h…',
      /** The field's help: «45 min al día». */
      minutesHelp: (perDay: string): string => perDay,
      minutesInvalid: 'Escribe cuánto: 30, 45 min, 1 h…',
      minutesRange: 'Entre 5 min y 12 h al día',
      days: 'Días que bloquea',
      daysHelp: 'El uso cuenta todos los días; solo bloquea los elegidos',
      targets: 'Qué limitar',
      categoriesLabel: 'Categorías que limita',
      extrasLabel: 'También limita',
      removeTarget: (what: string): string => `Quitar ${what}`,
      fromForm: 'Añadir lo del formulario de arriba',
      mode: 'Al agotarse',
      reason: 'Tu motivo',
      reasonLabel: 'Tu motivo (opcional)',
      reasonPlaceholder: 'Quiero dormir más',
      rowLabel: 'Guardar el límite',
      save: 'Guardar',
      saveHelp: 'Endurecerlo se aplica ya; suavizarlo espera 24 h',
      saving: 'Guardando…',
      /** An edit that softens it: said before saving. */
      weakens: (when: string): string =>
        `Esto lo suaviza: se aplicará ${when} (lo que lo endurece, ya)`,
      remove: 'Borrar',
      removeHelp: 'Se borra dentro de 24 h; hasta entonces sigue contando',
      removeConsequence: (name: string, when: string): string =>
        `«${name}» se borrará ${when}; el bloqueo de hoy sigue`,
      cancel: 'Cancelar',
      cancelHelp: 'Cierra sin guardar',
      consequence: 'Cuando se agote, no podrás desbloquearlo de ninguna forma hasta medianoche',
      problem: {
        noTargets: 'Elige qué limitar',
        minutes: 'Entre 5 min y 12 h al día',
        minutesText: 'Escribe cuánto: 30, 45 min, 1 h…',
        noDays: 'Elige al menos un día',
        nameLong: (max: number): string => `El nombre, como mucho ${max} letras`,
        full: (max: number): string => `Ya tienes ${max} límites: borra alguno antes`,
      },
      errors: {
        tooMany: 'Tus límites ya tienen demasiadas webs propias',
        notFound: 'Ese límite ya no existe',
        invalid: 'El guardián no acepta este límite: revisa los minutos y los días',
      },
      saved: (summary: string): string => `Guardado: ${summary}`,
      savedPending: (summary: string, when: string): string =>
        `Guardado: ${summary}. Lo que lo suaviza se aplicará ${when}`,
      removed: (name: string, when: string): string => `«${name}» se borrará ${when}`,
    },
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

    whitelist: {
      /** «Tu lista blanca: 3 extras · 1 esperando». */
      title: (n: number, waiting: number): string =>
        (n === 0
          ? 'Tu lista blanca: solo la de estudio'
          : n === 1
            ? 'Tu lista blanca: 1 extra'
            : `Tu lista blanca: ${n} extras`) + (waiting > 0 ? ` · ${waiting} esperando` : ''),
      loading: 'Tu lista blanca: cargando…',
      unavailable: 'Tu lista blanca: sin conexión',
      retry: 'Reintentar',
      listLabel: 'Webs y apps que añades a la lista blanca',
      domainsLabel: 'Webs permitidas',
      domainPlaceholder: 'wikipedia.org',
      appsLabel: 'Apps permitidas',
      appPlaceholder: 'WINWORD.EXE',
      suggestionsLabel: 'Programas abiertos que coinciden',
      add: 'Permitir',
      addDomainHelp: 'La añade a tu lista blanca',
      addAppHelp: 'La añade a tu lista blanca',
      help: 'Añadir espera 24 h, para no aflojar en caliente; quitar es al momento',
      /** «geogebra.org · desde mañana 17:10». */
      pendingChip: (label: string, when: string): string => `${label} · desde ${when}`,
      remove: (label: string): string => `Quitar ${label}`,
      removePending: (label: string, when: string): string =>
        `Quitar ${label} (se permitiría ${when})`,
      invalidDomain: 'Eso no parece una web: prueba con wikipedia.org',
      invalidApp: 'Escribe el nombre del programa, por ejemplo WINWORD.EXE',
      studyDefault: 'Ya está en la lista de estudio',
      duplicate: 'Ya está en tu lista',
      coveredBy: (parent: string): string => `Ya la permite ${parent}`,
      protectedDomain: 'Eso ya se permite siempre: el sistema lo necesita',
      protectedApp: 'Ese programa ya se permite siempre: el sistema lo necesita',
      maxDomains: (n: number): string => `Como mucho ${n} webs`,
      maxApps: (n: number): string => `Como mucho ${n} apps`,
      invalidList: 'El guardián no acepta la lista: revisa lo que has añadido',
      /** Why a distraction cannot be allowed (`findAllowDistraction`, 422 `allow_distraction`). */
      distraction: {
        serviceDomain: (domain: string, service: string): string =>
          `${domain} es de ${service}: una distracción no puede ir en la lista blanca`,
        parentOfService: (domain: string, service: string): string =>
          `${domain} incluye ${service}: escribe una web más concreta`,
        publicSuffix: (domain: string): string =>
          `${domain} es demasiado general: escribe una web concreta`,
        app: (app: string): string => `${app} es una distracción: no puede ir en la lista blanca`,
        generic: (value: string): string =>
          `${value} es una distracción: no puede ir en la lista blanca`,
      },
      added: (value: string): string => `Permitida: ${value}`,
      /** A weakening change waits 24 h. */
      addedPending: (value: string, when: string): string =>
        `${value} se permitirá ${when}: lo que afloja espera 24 h`,
      removed: (value: string): string => `Quitada: ${value}`,
    },
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

/** Shape every language file of the window must match. */
export type BloqueosMessages = Widen<typeof BLOQUEOS_ES>;
