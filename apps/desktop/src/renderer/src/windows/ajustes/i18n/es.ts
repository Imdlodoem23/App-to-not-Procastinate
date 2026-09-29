/**
 * Spanish strings of the Ajustes window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle ›
 * Ajustes»). Numbers, points and clock times are formatted before they get here. `en.ts` has the
 * same shape (`AjustesMessages`).
 *
 * Every settings row is 48 px: its title and its description stay on one line each, so the
 * descriptions are short (about 80 characters beside a switch, 40 beside four tiles).
 */
import type { ThemePreference } from '@centrate/shared/design/tokens';
import type { PunishmentLevel } from '@centrate/shared/domain';
import type { DefaultBlockMode } from '../../../../../shared/ui-state';
import type { LanguagePreference, Widen } from '../../../../../shared/i18n/locale';
import type {
  ActiveWindowState,
  PermissionOutcome,
  UpdaterStatus,
} from '../../../../../shared/platform';
import type { ShortcutAction } from '../../../../../shared/prefs';

export const AJUSTES_ES = {
  general: {
    /** «Cosa: valor»: the group says the theme it applies. */
    title: {
      system: 'General: tema del sistema',
      light: 'General: tema claro',
      dark: 'General: tema oscuro',
    } satisfies Record<ThemePreference, string>,
    themeLabel: 'Tema',
    themes: {
      system: 'Sistema',
      light: 'Claro',
      dark: 'Oscuro',
    } satisfies Record<ThemePreference, string>,
    themeHelp: {
      system: 'Sigue el tema de tu ordenador y cambia con él',
      light: 'Siempre claro',
      dark: 'Siempre oscuro',
    } satisfies Record<ThemePreference, string>,
    /** Description of the «Tema» row while no option is hovered or focused. */
    themeRowHelp: 'Se aplica al momento',
    language: 'Idioma',
    /** Description of the «Idioma» row while no option is hovered or focused. */
    languageDesc: 'El idioma de la app; se aplica al momento',
    languages: {
      system: 'Sistema',
      es: 'Español',
      en: 'English',
    } satisfies Record<LanguagePreference, string>,
    languageHelp: {
      system: 'Sigue el idioma de tu ordenador',
      es: 'Siempre en español',
      en: 'Siempre en inglés',
    } satisfies Record<LanguagePreference, string>,
    autostart: 'Arranque automático',
    autostartDesc: 'Céntrate se abre en la bandeja al iniciar sesión',
    dailyGoal: 'Objetivo diario',
    dailyGoalDesc: 'Minutos concentrado al día para la racha',
    /** «60 min» (the value, and each option). */
    dailyGoalValue: (minutes: string): string => `${minutes} min`,
    /** What each goal option does (the row's description while it is hovered or focused). */
    goalHelp: {
      current: 'Tu objetivo ahora',
      raise: 'Subirlo se aplica al momento',
      /** «Bajarlo se aplicará en 24 h». */
      lower: (when: string): string => `Bajarlo se aplicará ${when}`,
      /** The value already waiting: «Ya pedido: se aplicará en 23 h». */
      pending: (when: string): string => `Ya pedido: se aplicará ${when}`,
      /** The current goal while a lower one waits. */
      cancel: 'Tu objetivo ahora: anula el cambio pedido',
    },
    sound: 'Sonido de concentración',
    soundDesc: 'Lluvia, ruido blanco o lo-fi; suena sin internet',
    volume: 'Volumen',
    volumeDesc: 'Del sonido de concentración',
    /** «60 %». */
    volumeValue: (percent: string): string => `${percent} %`,
    autoplay: 'Sonar durante los bloqueos',
    autoplayDesc: 'El sonido empieza solo mientras hay un bloqueo activo',
    osd: 'Avisos grandes',
    osdDesc: 'Un aviso en pantalla al usar la bandeja o un atajo',
  },
  /** «Atajo global» (General): one row per action, the combination in a field on the right. */
  shortcuts: {
    titles: {
      'toggle-main': 'Atajo: mostrar Céntrate',
      'extend-15': 'Atajo: ampliar 15 min',
      'toggle-mini-timer': 'Atajo: mini temporizador',
    } satisfies Record<ShortcutAction, string>,
    descs: {
      'toggle-main': 'Muestra u oculta la ventana desde cualquier app',
      'extend-15': 'Suma 15 min al bloqueo que acaba más tarde',
      'toggle-mini-timer': 'Muestra u oculta el reloj pequeño',
    } satisfies Record<ShortcutAction, string>,
    /** Field placeholder when the action has no combination. */
    none: 'Sin atajo',
    /** Field placeholder while recording. */
    press: 'Pulsa las teclas',
    /** Row description while recording. */
    capturing: 'Pulsa la combinación · Retroceso lo quita · Esc cancela',
    needModifier: 'Usa Ctrl o Alt con una tecla',
    /** «Ya lo usa "Atajo: ampliar 15 min"». */
    taken: (other: string): string => `Ya lo usa «${other}»`,
    failed: 'Otra app ya usa este atajo: elige otro',
    /** Screen readers, after a change. */
    saved: (combo: string): string => `Atajo guardado: ${combo}`,
    cleared: 'Atajo quitado',
    /** Key names in a combination («Ctrl+Alt+C», «Cmd+Opción+C»). */
    keys: {
      ctrl: 'Ctrl',
      cmd: 'Cmd',
      alt: 'Alt',
      option: 'Opción',
      shift: 'Mayús',
      win: 'Win',
      super: 'Super',
      space: 'Espacio',
      enter: 'Intro',
      tab: 'Tab',
      backspace: 'Retroceso',
      delete: 'Supr',
      insert: 'Insert',
      escape: 'Esc',
      up: 'Arriba',
      down: 'Abajo',
      left: 'Izquierda',
      right: 'Derecha',
      home: 'Inicio',
      end: 'Fin',
      pageUp: 'RePág',
      pageDown: 'AvPág',
      plus: 'Más',
    },
  },
  bloqueo: {
    /** «Bloqueo: Normal por defecto». */
    title: (mode: string): string => `Bloqueo: ${mode} por defecto`,
    defaultModeLabel: 'Modo por defecto',
    /** Shown in the row's description (one line beside the three tiles). */
    modeHelp: {
      normal: 'Normal: emergencia de 10 min y al menos 200 puntos',
      strict: 'Estricto: emergencia de 30 min y al menos 200 puntos',
      hardcore: 'Hardcore: no se puede cancelar de ninguna forma',
    } satisfies Record<DefaultBlockMode, string>,
    modeRowHelp: 'El modo con el que se abre la confirmación',
    closeBrowsers: 'Cerrar navegadores sin extensión',
    closeBrowsersDesc: 'Durante un bloqueo, cierra los navegadores que no la tengan activa',
    /** While on: turning it off is a weakening change («quitarlo tarda 24 h»). */
    closeBrowsersOnDesc: (delay: string): string =>
      `Los cierra durante un bloqueo; quitarlo tarda ${delay}`,
    penalties: 'Penalizaciones',
    penaltiesDesc: 'Cada intento de entrar en algo bloqueado resta puntos',
    penaltiesOnDesc: (delay: string): string =>
      `Cada intento resta puntos; quitarlas tarda ${delay}`,
    penaltiesOffDesc: 'Los intentos no restan puntos',
    /** The read-only list of what costs points (`POINT_RULES`, `EMERGENCY_RULES`). */
    values: {
      label: 'Lo que resta puntos',
      attempt: 'Intento bloqueado',
      /** «−10; si repites en 5 min, −20, −40… hasta −80». */
      attemptValue: (base: string, next: string, cap: string, minutes: string): string =>
        `${base}; si repites en ${minutes} min, ${next}… hasta ${cap}`,
      attemptOff: 'Nada mientras las penalizaciones estén quitadas',
      strike: 'Strike del Study Mode',
      punishment: 'Castigo',
      emergency: 'Desbloqueo de emergencia',
      /** «−200 o la mitad del saldo si es más, y la racha». */
      emergencyValue: (min: string): string => `${min} o la mitad del saldo si es más, y la racha`,
    },
    reminders: 'Recordatorio de horarios',
    /** «"Es tu hora de estudiar" 5 min antes de cada horario». */
    remindersDesc: (minutes: number): string =>
      minutes === 0
        ? '«Es tu hora de estudiar» al empezar cada horario'
        : `«Es tu hora de estudiar» ${minutes} min antes de cada horario`,
    eyeBreaks: 'Regla 20-20-20',
    eyeBreaksDesc: 'Cada 20 min de bloqueo, mira a 6 metros durante 20 segundos',
    /** The guardian's own settings while they are being read or cannot be. */
    guardianSettings: 'Ajustes del guardián',
    guardianSettingsLoading: 'Leyendo…',
  },
  /** The Study Mode group (`study` flag): the guardian's punishment level and duration. */
  study: {
    title: 'Study Mode: castigo',
    level: 'Nivel de castigo',
    /** «Tras 3 strikes, durante 60 min; se aplica al momento». */
    levelDesc: (strikes: number, minutes: string): string =>
      `Tras ${strikes} strikes, durante ${minutes} min; se aplica al momento`,
    levels: {
      distractions: '1 · Distracciones',
      whitelist: '2 · Lista blanca',
      nuclear: 'Nuclear',
    } satisfies Record<PunishmentLevel, string>,
    levelHelp: {
      distractions: 'Nivel 1: se bloquean todas las webs y apps que distraen',
      whitelist: 'Nivel 2: solo se pueden usar las webs y apps de estudio',
      nuclear: 'Nuclear: tapa todas las pantallas hasta que acaba, con salida de emergencia',
    } satisfies Record<PunishmentLevel, string>,
    /** In red while «Nuclear» asks «¿Seguro?». */
    nuclearConsequence: 'En un castigo no podrás usar el ordenador, salvo la salida de emergencia',
    /** PROMPT §8: honest about the limits. */
    adminNote: 'Si eres administrador del ordenador, ningún bloqueo es 100 % imposible de saltar',
    saved: (level: string): string => `Nivel de castigo: ${level}`,
    duration: 'Duración del castigo',
    durationDesc: 'Cuánto dura el castigo tras el último strike',
    /** «60 min». */
    durationValue: (minutes: string): string => `${minutes} min`,
    durationSaved: (minutes: string): string => `Duración del castigo: ${minutes} min`,
  },
  /**
   * «Mantener despierto» (ARCHITECTURE §5.11): the guardian keeps the computer from sleeping on
   * idle, also with Céntrate closed; the app keeps the screen on while it runs.
   */
  keepAwake: {
    /** «Cosa: valor»: what it does now. */
    title: {
      off: 'Mantener despierto: desactivado',
      forever: 'Mantener despierto: hasta que lo desactives',
      /** «Mantener despierto: hasta las 18:30». */
      until: (until: string): string => `Mantener despierto: ${until}`,
    },
    toggle: 'Mantener despierto',
    toggleDesc: {
      off: 'Que el equipo no se suspenda por inactividad, aunque cierres Céntrate',
      on: 'Sigue aunque cierres Céntrate o reinicies el equipo',
    },
    duration: 'Duración',
    durationDesc: 'Otra duración con él activado empieza la cuenta de nuevo',
    /** The slider's last stop (the tray says «Hasta que lo desactive»). */
    forever: 'Sin límite',
    display: 'Mantener también la pantalla encendida',
    displayDesc: 'Solo mientras Céntrate está abierto, también en la bandeja',
    /** Under the group: what it never does. */
    note: 'Solo evita la suspensión por inactividad: cerrar la tapa sigue suspendiendo el equipo',
    /** Screen readers, after a change (the switch and the title already show it). */
    saved: {
      on: 'Mantener despierto: activado',
      off: 'Mantener despierto: desactivado',
      duration: (label: string): string => `Duración: ${label}`,
      displayOn: 'La pantalla se mantendrá encendida',
      displayOff: 'La pantalla se apagará como siempre',
    },
  },
  sistema: {
    title: {
      ok: 'Sistema: todo en orden',
      connecting: 'Sistema: conectando…',
      stopped: 'Sistema: guardián detenido',
      notInstalled: 'Sistema: guardián no instalado',
      outdated: 'Sistema: actualiza el guardián',
      problems: 'Sistema: revisa el guardián',
      extension: 'Sistema: revisa la extensión',
      update: 'Sistema: hay una versión nueva',
    },
    guardian: 'Guardián',
    guardianStatus: {
      ok: 'Activo',
      connecting: 'Conectando…',
      stopped: 'Detenido',
      notInstalled: 'No instalado',
      outdated: 'Desactualizado',
      safe: 'En modo seguro',
      problems: 'Con problemas',
    },
    /** «Versión 0.1.0». */
    version: (v: string): string => `Versión ${v}`,
    hostsOk: 'archivo hosts: bien',
    hostsBad: 'archivo hosts: con problemas',
    watcherOk: 'vigilante de apps: bien',
    watcherBad: 'vigilante de apps: con problemas',
    guardianDown: 'Ahora mismo no se bloquea nada',
    guardianDesc: 'Aplica los bloqueos aunque cierres la app',
    repair: 'Reparar',
    install: 'Instalar',
    repairing: 'Reparando…',
    /** «Extensión en Chrome». */
    extension: (browser: string): string => `Extensión en ${browser}`,
    extensionNone: 'Extensión: sin emparejar',
    extensionNoneDesc: 'Instálala en tu navegador y emparéjala con un código',
    extensionStatus: {
      ok: 'Conectada',
      disconnected: 'Desconectada',
      permission: 'Sin permiso',
      incognito: 'Falta incógnito',
    },
    extensionDesc: {
      ok: 'Bloquea al instante, también en incógnito',
      disconnected: 'Abre el navegador para que se conecte',
      permission: 'Falta el permiso para leer todas las webs',
      incognito: 'Falta permitirla en las ventanas de incógnito',
    },
    /** «Firefox no tiene la extensión». */
    browserMissing: (browser: string): string => `${browser} no tiene la extensión`,
    browserMissingDesc: 'Ahí el bloqueo puede tardar: instálala',
    guide: 'Guía',
    pairing: 'Código de emparejamiento',
    pairingDesc: 'Escríbelo en la extensión la primera vez',
    pairingNew: 'Nuevo código',
    pairingExpired: 'Caducado: pide otro',
    /** «Caduca en» + countdown. */
    pairingExpires: 'Caduca en',
    /** «Puerto: 47601» (only when not the default). */
    pairingPort: (port: string): string => `Puerto: ${port}`,
    pairingCodeLabel: (code: string): string => `Código de emparejamiento: ${code}`,
    /** Screen readers, when «Nuevo código» answers: «Código nuevo: 4 8 2 9 1 3. Caduca en 5 min». */
    pairingSpoken: (spacedCode: string, minutes: number): string =>
      `Código nuevo: ${spacedCode}. Caduca en ${minutes} min`,
    guidesLabel: 'Guías de la extensión',
    guides: {
      'extension-chromium': 'Chrome y Edge',
      'extension-firefox': 'Firefox',
      'extension-incognito': 'Incógnito',
    },
    guidesHelp: {
      'extension-chromium': 'Cómo instalarla en Chrome, Edge, Brave y otros',
      'extension-firefox': 'Cómo instalarla en Firefox',
      'extension-incognito': 'Cómo permitirla en las ventanas de incógnito',
    },
    guidesRowHelp: 'Paso a paso, en tu navegador',
    /** The backup layer that reads the window in front (PROMPT §5 «Ventana activa»). */
    activeWindow: {
      title: 'Ventana activa',
      status: {
        off: 'En espera',
        ok: 'Vigilando',
        'needs-permission': 'Sin permiso',
        unsupported: 'No disponible',
        error: 'Con problemas',
      } satisfies Record<ActiveWindowState, string>,
      desc: {
        off: 'Durante un bloqueo, mira qué ventana tienes delante',
        ok: 'Cuenta un intento si la ventana de delante está bloqueada',
        'needs-permission': 'macOS pide el permiso de Grabación de pantalla',
        unsupported: 'Tu sistema no deja leerla; lo demás sigue bloqueando',
        error: 'No se ha podido leer; se reintentará sola',
      } satisfies Record<ActiveWindowState, string>,
      /** «Último intento: YouTube a las 16:58». */
      lastMatch: (service: string, clock: string): string =>
        `Último intento: ${service} a las ${clock}`,
      allow: 'Activar',
      outcome: {
        granted: 'Permiso concedido',
        'opened-settings': 'Activa Céntrate en Ajustes del Sistema › Grabación de pantalla',
        unsupported: 'Aquí no hace falta ningún permiso',
      } satisfies Record<PermissionOutcome, string>,
    },
    camera: {
      title: 'Cámara',
      status: 'Sin usar',
      desc: 'La pedirá el Study Mode; ninguna imagen sale de tu ordenador',
    },
    updater: {
      title: 'Actualizaciones',
      status: {
        idle: 'sin comprobar',
        checking: 'comprobando…',
        current: 'al día',
        available: 'nueva versión',
        downloading: 'descargando',
        ready: 'lista para instalar',
        error: 'no se ha podido comprobar',
        unsupported: 'las gestiona tu sistema',
      } satisfies Record<UpdaterStatus, string>,
      /** «Tienes la v0.1.0». */
      current: (version: string): string => `Tienes la v${version}`,
      /** «v0.1.0 es la última · comprobado a las 16:30». */
      upToDate: (version: string, clock: string): string =>
        `v${version} es la última · comprobado a las ${clock}`,
      /** «v0.2.0 disponible; tienes la v0.1.0». */
      available: (next: string, current: string): string =>
        `v${next} disponible; tienes la v${current}`,
      /** «Descargando v0.2.0 · 45 %». */
      downloading: (next: string, percent: string): string => `Descargando v${next} · ${percent} %`,
      /** «v0.2.0 se instala al reiniciar; los bloqueos siguen». */
      ready: (next: string): string => `v${next} se instala al reiniciar; los bloqueos siguen`,
      error: 'Sin conexión o sin respuesta; prueba más tarde',
      unsupported: 'Esta instalación se actualiza por su cuenta',
      actions: {
        check: 'Comprobar ya',
        download: 'Descargar ya',
        install: 'Reiniciar y actualizar',
        checking: 'Comprobando…',
        downloading: 'Descargando…',
      },
    },
    onboarding: {
      title: 'Primeros pasos',
      desc: 'Guardián, extensión y tu primer bloqueo, otra vez',
      action: 'Empezar de nuevo',
    },
    diagnostics: 'Diagnóstico',
    diagnosticsDesc: 'Para pedir ayuda: sin tus webs, motivos ni nombre',
    diagnosticsCopy: 'Copiar diagnóstico',
    diagnosticsCopied: 'Copiado al portapapeles',
    diagnosticsFallback: 'Copiado: el guardián no responde, va lo que ve la app',
    /** Screen readers (the description above already says «Copiado…» on screen). */
    diagnosticsSpoken: {
      guardian: 'Diagnóstico copiado al portapapeles',
      fallback: 'Diagnóstico copiado: el guardián no responde, va lo que ve la app',
    },
  },
  datos: {
    /** «Cosa: valor»: where the data lives. */
    title: 'Datos: en este ordenador',
    export: 'Exportar a CSV',
    exportDesc: 'Para abrirlos en una hoja de cálculo',
    exportEvents: 'Exportar eventos',
    exportDays: 'Exportar días',
    /** «Guardado: centrate-eventos-2026-09-28.csv (48 filas)». */
    exported: (file: string, rows: number): string =>
      `Guardado: ${file} (${rows === 1 ? '1 fila' : `${rows} filas`})`,
    exportCancelled: 'No se ha guardado nada',
    delete: 'Borrar todos mis datos',
    deleteDesc: 'Puntos, racha, historial y plantillas; los bloqueos siguen',
    deleteWordLabel: 'Escribe BORRAR para confirmar',
    deleteWordPlaceholder: 'BORRAR',
    deleteButton: 'Borrar',
    deleteNeedsWord: 'Escribe BORRAR para poder borrar',
    deleting: 'Borrando…',
    deleted: 'Hecho: tus datos se han borrado',
    /** «Hecho: tus datos se han borrado. 1 bloqueo en curso sigue activo». */
    deletedKept: (n: number): string =>
      n === 1
        ? 'Hecho: tus datos se han borrado. El bloqueo en curso sigue activo'
        : `Hecho: tus datos se han borrado. Los ${n} bloqueos en curso siguen activos`,
  },
  /** Weakening guardian settings wait (PROMPT §5, docs/ARCHITECTURE.md §5.8). */
  pending: {
    /** «Se aplicará en 24 h». */
    willApply: (when: string): string => `Se aplicará ${when}`,
    /** After a weakening change: «Se aplicará en 24 h: los cambios que protegen menos esperan». */
    weakened: (when: string): string =>
      `Se aplicará ${when}: los cambios que protegen menos esperan un día`,
    /** «Pasará a 30 min en 23 h». */
    goal: (minutes: string, when: string): string => `Pasará a ${minutes} min ${when}`,
    off: (when: string): string => `Se desactivará ${when}`,
    on: (when: string): string => `Se activará ${when}`,
    other: (when: string): string => `Cambio pendiente: se aplicará ${when}`,
    /** «en 23 h», «en 45 min». */
    in: (label: string): string => `en ${label}`,
    /** Screen readers, after a change that applied at once. */
    applied: 'Aplicado',
    /** Screen readers, after going back to the value in force (the wait is cancelled). */
    cancelled: 'Cambio pedido anulado',
  },
  saveFailed: 'No se ha podido guardar',
} as const;

/** Shape every language file of the window must match. */
export type AjustesMessages = Widen<typeof AJUSTES_ES>;
