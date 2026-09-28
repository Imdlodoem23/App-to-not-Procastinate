/**
 * Spanish strings of the Ajustes window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle ›
 * Ajustes»). Numbers, points and clock times are formatted before they get here. `en.ts` has the same
 * shape (`AjustesMessages`).
 */
import type { ThemePreference } from '@centrate/shared/design/tokens';
import type { DefaultBlockMode } from '../../../../../shared/ui-state';
import type { LanguagePreference, Widen } from '../../../../../shared/i18n/locale';

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
    dailyGoalDesc: 'Minutos concentrado al día para sumar racha',
    /** «60 min». */
    dailyGoalValue: (minutes: string): string => `${minutes} min`,
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
    penalties: 'Penalizaciones',
    penaltiesDesc: 'Cada intento de entrar en algo bloqueado resta puntos',
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
  /** Weakening guardian settings wait (PROMPT §5, docs/ARCHITECTURE.md). */
  pending: {
    /** «Se aplicará en 24 h». */
    willApply: (when: string): string => `Se aplicará ${when}`,
    /** «Pasará a 30 min en 23 h». */
    goal: (minutes: string, when: string): string => `Pasará a ${minutes} min ${when}`,
    off: (when: string): string => `Se desactivará ${when}`,
    on: (when: string): string => `Se activará ${when}`,
    other: (when: string): string => `Cambio pendiente: se aplicará ${when}`,
    /** «en 23 h», «en 45 min». */
    in: (label: string): string => `en ${label}`,
  },
  saveFailed: 'No se ha podido guardar',
} as const;

/** Shape every language file of the window must match. */
export type AjustesMessages = Widen<typeof AJUSTES_ES>;
