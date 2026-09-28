/**
 * Spanish strings of the extension pages: blocked.html, the popup and the guide (options).
 * PROMPT §10: sentence case, typographic minus «−», humor only on the blocked page, errors
 * with an action and penalties as a plain fact. Ready for an `en.ts` with the same shape
 * (`PagesMessages`).
 */
import type { BlockMode, BrowserFamily, PunishmentLevel } from '@centrate/shared/domain';
import type { PairErrorCode } from '../../background/state';

/** Official downloads (GitHub Releases of the project). */
const RELEASES_URL = 'https://github.com/Imdlodoem23/App-to-not-Procastinate/releases/latest';

/** «incógnito», «InPrivate», «ventanas privadas»: what each browser calls private windows. */
function privateName(family: BrowserFamily | null): string {
  switch (family) {
    case 'edge':
      return 'InPrivate';
    case 'firefox':
    case 'brave':
    case 'other':
    case null:
      return 'ventanas privadas';
    default:
      return 'incógnito';
  }
}

/** A duration in words: «43 minutos», «1 hora y 5 minutos». */
function durationWords(hours: number, minutes: number): string {
  const parts: string[] = [];
  if (hours > 0) parts.push(hours === 1 ? '1 hora' : `${hours} horas`);
  if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minuto' : `${minutes} minutos`);
  return parts.join(' y ');
}

/** Where one browser keeps «allow in incognito». */
export interface IncognitoBrowser {
  families: readonly BrowserFamily[];
  name: string;
  steps: string;
}

/** «Permitir en incógnito» per browser, in the browsers' own Spanish labels. */
const INCOGNITO_BROWSERS: readonly IncognitoBrowser[] = [
  {
    families: ['chrome', 'chromium'],
    name: 'Chrome',
    steps: 'chrome://extensions › Céntrate › Detalles › activa «Permitir en modo incógnito».',
  },
  {
    families: ['edge'],
    name: 'Edge',
    steps: 'edge://extensions › Céntrate › Detalles › activa «Permitir en InPrivate».',
  },
  {
    families: ['brave'],
    name: 'Brave',
    steps: 'brave://extensions › Céntrate › Detalles › activa «Permitir en privado».',
  },
  {
    families: ['opera', 'vivaldi'],
    name: 'Opera y Vivaldi',
    steps: 'En la página de extensiones, busca Céntrate y activa el permiso de incógnito.',
  },
  {
    families: ['firefox'],
    name: 'Firefox',
    steps: 'about:addons › Céntrate › «Ejecutar en ventanas privadas» › «Permitir».',
  },
];

/** Values a humor line may use. `name` starts a sentence, `inlineName` goes inside one. */
export interface HumorContext {
  name: string;
  inlineName: string;
  /** «43 minutos», «1 hora y 5 minutos»; `null` when the end is unknown. */
  time: string | null;
}

export const PAGES_ES = {
  appName: 'Céntrate',

  common: {
    modes: {
      normal: 'Normal',
      strict: 'Estricto',
      hardcore: 'Hardcore',
      exam: 'Examen',
    } satisfies Record<BlockMode, string>,
    punishmentLevels: {
      distractions: 'todas las distracciones',
      whitelist: 'solo lista blanca',
      nuclear: 'ordenador bloqueado',
    } satisfies Record<PunishmentLevel, string>,
    targets: {
      /** At the start of a line (a row): «Todo salvo la lista blanca · Examen». */
      whitelistOnly: 'Todo salvo la lista blanca',
      /** After «Bloqueo:» (a header): «Bloqueo: solo lista blanca · Examen». */
      whitelistShort: 'solo lista blanca',
      separator: ', ',
      /** «YouTube, Instagram +2». */
      more: (count: number): string => `+${count}`,
    },
    remaining: {
      /** «quedan 42 min» / «queda 1 min». `label` comes from `durationLabel`. */
      words: (minutes: number, label: string): string =>
        minutes === 1 ? `queda ${label}` : `quedan ${label}`,
      /** Countdown `aria-label`: «Quedan 43 minutos», «Quedan 1 hora y 5 minutos». */
      aria: (hours: number, minutes: number): string => {
        const one = (hours === 1 && minutes === 0) || (hours === 0 && minutes === 1);
        return `${one ? 'Queda' : 'Quedan'} ${durationWords(hours, minutes)}`;
      },
      /** Spoken at 15, 5 and 1 min (`aria-live="polite"`). */
      announce: (minutes: number): string =>
        minutes === 1 ? 'Queda 1 minuto' : `Quedan ${minutes} minutos`,
      ended: 'Bloqueo terminado',
      /** Prose duration for the humor lines: «43 minutos», «2 horas y 5 minutos». */
      prose: durationWords,
    },
    points: {
      /** «−10 puntos», «1 punto». `amount` is already formatted. */
      long: (amount: string, value: number): string =>
        Math.abs(value) === 1 ? `${amount} punto` : `${amount} puntos`,
    },
    browserNames: {
      chrome: 'Chrome',
      edge: 'Edge',
      brave: 'Brave',
      opera: 'Opera',
      vivaldi: 'Vivaldi',
      chromium: 'Chromium',
      firefox: 'Firefox',
      other: 'Otro navegador',
    } satisfies Record<BrowserFamily, string>,
    guide: 'Abrir guía',
    guideHelp: 'Paso a paso: emparejar, permisos, incógnito y privacidad',
    retry: 'Reintentar',
    retryHelp: 'Vuelve a buscar el guardián ahora',
    /** «v0.1.0». */
    version: (version: string): string => `v${version}`,
    privateName,
  },

  /** Connection line of the popup footer and the guide. */
  status: {
    connected: 'Guardián conectado',
    connecting: 'Conectando con el guardián…',
    unreachable: 'Guardián no responde',
    unauthorized: 'Emparejamiento revocado',
    untrusted: 'Respuesta del guardián no válida',
    error: 'Error del guardián',
    notPaired: 'Sin emparejar',
  },

  /** Warnings of the popup (section «Aviso de protección»), one per problem. */
  notices: {
    unauthorized:
      'El guardián ha revocado este emparejamiento: empareja otra vez con un código nuevo.',
    host_permission_missing:
      'El navegador no deja a Céntrate acceder a las webs: ahora mismo no bloquea nada aquí.',
    guardian_unreachable: 'Guardián no responde: tus bloqueos siguen hasta que terminen.',
    guardian_unreachable_empty:
      'Guardián no responde: abre Céntrate en este ordenador para comprobar que está activo.',
    untrusted_rules:
      'El guardián ha enviado una respuesta no válida: se mantienen tus bloqueos hasta que terminen.',
    browser_mismatch:
      'Este emparejamiento es de otro navegador: empareja desde aquí con un código nuevo.',
    peer_not_browser: 'El guardián no reconoce este navegador. Mira qué hacer en la guía.',
    origin_not_allowed:
      'El guardián no reconoce esta extensión: instálala desde el paquete oficial.',
    guardian_error: 'El guardián ha dado un error: se mantienen tus bloqueos hasta que terminen.',
    /** «En incógnito no se bloquea nada: permite la extensión ahí». */
    incognito_not_allowed: (family: BrowserFamily | null): string => {
      const name = privateName(family);
      const where = name === 'ventanas privadas' ? 'las ventanas privadas' : name;
      return `En ${where} no se bloquea nada: permite la extensión ahí.`;
    },
    actions: {
      grant: 'Dar permiso',
      grantHelp: 'El navegador te pedirá acceso a todas las webs',
      howTo: 'Cómo hacerlo…',
      howToHelp: 'Abre la guía en este paso',
      guide: 'Guía…',
    },
  },

  pairing: {
    /** Header of the pairing section: «Extensión: sin emparejar». */
    title: 'Extensión: sin emparejar',
    titleAgain: 'Extensión: emparejar otra vez',
    intro:
      'En Céntrate, abre Ajustes… › Sistema y pulsa «Nuevo código». Escribe aquí los 6 dígitos.',
    codeLabel: 'Código de emparejamiento',
    codePlaceholder: '6 dígitos',
    submit: 'Emparejar',
    submitting: 'Emparejando…',
    portToggle: 'Otro puerto…',
    portToggleHelp: 'Solo si la app muestra «Puerto: N»',
    portLabel: 'Puerto',
    success: 'Emparejada: ya aplica tus bloqueos.',
    errors: {
      invalid_format: 'El código tiene 6 dígitos. Revísalo y vuelve a probar.',
      code_invalid: 'Ese código no es válido. Compruébalo en la app y vuelve a escribirlo.',
      code_expired: 'El código ha caducado. Pide otro en la app con «Nuevo código».',
      no_code: 'La app no ha creado ningún código. Pulsa «Nuevo código» en Ajustes… › Sistema.',
      peer_not_browser:
        'El guardián no ha reconocido este navegador. Mira «Si algo falla» en la guía.',
      origin_not_allowed:
        'El guardián no reconoce esta extensión. Instálala desde el paquete oficial (mira la guía).',
      rate_limited: 'Demasiados intentos. Espera un momento y vuelve a probar.',
      unreachable:
        'No encuentro el guardián en este ordenador. Abre Céntrate para comprobar que está activo.',
      timeout: 'El guardián no ha respondido a tiempo. Vuelve a probar.',
      read_only:
        'El guardián está en modo seguro y ahora no puede emparejar. Ábrelo en Céntrate y pulsa Reparar.',
      key_changed:
        'Ese código no viene del guardián que firma tus bloqueos activos. Podrás emparejar con otro cuando terminen.',
      guardian_elsewhere:
        'El guardián sigue activo en el puerto emparejado. Empareja sin cambiar el puerto.',
      unexpected: 'Algo ha fallado al emparejar. Vuelve a probar.',
    } satisfies Record<PairErrorCode, string>,
    /** «Demasiados intentos. Espera 30 s y vuelve a probar.» */
    rateLimitedFor: (seconds: number): string =>
      `Demasiados intentos. Espera ${seconds} s y vuelve a probar.`,
    badPort: 'El puerto es un número entre 1 y 65535.',
    extensionUnavailable: 'No puedo hablar con la extensión. Ciérrala y vuelve a abrirla.',
  },

  blocked: {
    /** Tab title: «YouTube: bloqueado · Céntrate». */
    documentTitle: (title: string): string => `${title} · Céntrate`,
    /** «YouTube: bloqueado», «reddit.com: bloqueado». */
    title: (name: string): string => `${name}: bloqueado`,
    /** When the site is unknown (opened by hand, nothing from the background yet). */
    titleUnknown: 'Esta web: bloqueada',
    unknownName: 'Esta web',
    unknownInlineName: 'esta web',
    /** Once the block has ended: «YouTube: bloqueo terminado». */
    titleEnded: (name: string): string => `${name}: bloqueo terminado`,
    titleEndedUnknown: 'Esta web: bloqueo terminado',
    /** Header value once the end has passed but the block is still enforced (boot hold). */
    checking: 'Comprobando la hora…',
    /** Grey line meanwhile: «Podrás entrar en YouTube en cuanto Céntrate confirme la hora.» */
    checkingLine: (inlineName: string): string =>
      `Podrás entrar en ${inlineName} en cuanto Céntrate confirme la hora.`,
    reasonLabel: 'Tu motivo',
    /** Under «−10 puntos» after a reload or a second tab: no new charge. */
    sameAttempt: 'Es el mismo intento: no se ha vuelto a cobrar.',
    enforced: 'Esta pestaña ya estaba abierta al empezar el bloqueo: no cuenta como intento.',
    back: 'Volver a lo mío',
    backHelpHistory: 'Vuelve a la página anterior',
    backHelpNewTab: 'Cierra esta página y abre una pestaña nueva',
    /** The single tile once the block has ended: «Abrir YouTube». */
    open: (name: string): string => `Abrir ${name}`,
    openHelp: 'Abre en esta pestaña la página que intentabas ver',
    /** Grey line once the block has ended (the title already says «bloqueo terminado»). */
    endedLine: 'Ya puedes volver a entrar.',
    /** Whitelist pages: the exam mode, and the other whitelist blocks (punishment level 2). */
    examLine: 'Modo examen: aquí solo entra lo que has permitido. Suerte.',
    whitelistLine: 'Solo están abiertas las webs de tu lista. Todo lo demás puede esperar.',
    /** Rotated per load; `time` is `null` when the end is unknown (those lines are skipped). */
    humor: [
      (c: HumorContext): string | null =>
        c.time === null ? null : `${c.name} seguirá ahí dentro de ${c.time}. Tus deberes, no.`,
      (c: HumorContext): string | null =>
        c.time === null ? null : `${c.name} puede esperar ${c.time}. Lo tuyo, no tanto.`,
      (c: HumorContext): string | null =>
        c.time === null ? null : `Tu yo de dentro de ${c.time} te lo va a agradecer.`,
      (c: HumorContext): string => `${c.name} no se va a ir a ningún sitio. Tu concentración, sí.`,
      (c: HumorContext): string =>
        `Nadie ha aprobado nunca gracias a ${c.inlineName}. Que se sepa.`,
    ],
    /** Accessible name of the region shown inside a blocked embed. */
    framedLabel: 'Contenido bloqueado por Céntrate',
  },

  popup: {
    documentTitle: 'Céntrate',
    blockNone: 'Bloqueo: ninguno',
    blockNoneHelp: 'Crea bloqueos desde la app Céntrate: aquí se aplican solos.',
    /** «Bloqueo: YouTube, Instagram · Estricto». */
    block: (targets: string, mode: string): string => `Bloqueo: ${targets} · ${mode}`,
    /** «Castigo: todas las distracciones». */
    punishment: (level: string): string => `Castigo: ${level}`,
    /** 28 px rows under the countdown: «Reddit · Normal». */
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    /** «Descanso: YouTube». */
    allowance: (name: string): string => `Descanso: ${name}`,
    /** «y 3 más». */
    more: (count: number): string => `y ${count} más`,
    blocksLabel: 'Bloqueos activos',
    noticesLabel: 'Avisos',
    /** «Reintentar» while the background asks the guardian again. */
    retrying: 'Reintentando…',
    /** «comprobado a las 17:42»: when a «Reintentar» that did not fix it ran. */
    checkedAt: (time: string): string => `comprobado a las ${time}`,
    /** Next to the notice's «Reintentar»: «Sigue sin responder · comprobado a las 17:42». */
    retryStill: (unreachable: boolean, checked: string): string =>
      `${unreachable ? 'Sigue sin responder' : 'Sigue fallando'} · ${checked}`,
    /** The footer line after its own «Reintentar»: «Guardián no responde · comprobado a las 17:42». */
    footerChecked: (line: string, checked: string): string => `${line} · ${checked}`,
  },

  guide: {
    documentTitle: 'Guía de la extensión · Céntrate',
    title: 'Guía de la extensión',
    intro:
      'La extensión aplica en el navegador los mismos bloqueos que Céntrate en el resto del ordenador. Necesita estar emparejada con el guardián y tener permiso para ver a qué webs vas.',
    tocLabel: 'En esta guía',
    toc: {
      pairing: 'Emparejar',
      'host-permission': 'Permiso de acceso',
      incognito: 'Incógnito',
      chromium: 'Chrome, Edge y Brave',
      firefox: 'Firefox',
      privacy: 'Privacidad',
      troubleshooting: 'Si algo falla',
    },
    yourBrowser: 'tu navegador',
    /** «hoy a las 17:42». */
    whenToday: (time: string): string => `hoy a las ${time}`,
    /** «el 28/9 a las 17:42». */
    whenDate: (date: string, time: string): string => `el ${date} a las ${time}`,
    releasesUrl: RELEASES_URL,
    releasesLink: 'Descargas de Céntrate en GitHub',
    pairing: {
      title: 'Emparejar',
      /** «Emparejar: hecho» / «Emparejar: pendiente». */
      done: 'Emparejar: hecho',
      pending: 'Emparejar: pendiente',
      steps: [
        'Instala Céntrate en este ordenador y ábrelo.',
        'En Céntrate, abre Ajustes… › Sistema y pulsa «Nuevo código». Verás 6 dígitos que caducan a los 5 minutos.',
        'Escríbelos aquí debajo o en la ventana de la extensión (el icono de Céntrate en la barra del navegador).',
      ],
      note: 'Si la app muestra «Puerto: N», pulsa «Otro puerto…» y escríbelo también. Emparejar otra vez nunca acorta un bloqueo en curso.',
      /** «Emparejada con el guardián 0.1.0 el 28/9 a las 17:42». */
      pairedWith: (version: string, when: string): string =>
        `Emparejada con el guardián ${version} ${when}.`,
      again: 'Emparejar otra vez…',
    },
    chromium: {
      title: 'Instalar en Chrome, Edge y Brave',
      steps: [
        'Descarga Centrate-extension.zip de la última versión y descomprímelo en una carpeta que no vayas a borrar.',
        'Abre la página de extensiones: chrome://extensions en Chrome, edge://extensions en Edge o brave://extensions en Brave.',
        'Activa el «Modo de desarrollador» (arriba a la derecha; en Edge, en el panel de la izquierda).',
        'Pulsa «Cargar descomprimida» (en Edge, «Cargar desempaquetada») y elige la carpeta que has descomprimido.',
        'Fija Céntrate en la barra (el icono de la pieza de puzle) y empareja con el código.',
      ],
      notes: [
        'El navegador puede avisarte de que tienes extensiones en modo de desarrollador: es normal, no la desactives.',
        'Para actualizarla, sustituye los archivos de la carpeta y pulsa el botón de recargar (↻) en la tarjeta de Céntrate. El emparejamiento se mantiene.',
      ],
    },
    firefox: {
      title: 'Instalar en Firefox',
      steps: [
        'Necesitas Firefox 128 o posterior.',
        'Descarga el archivo .xpi de la última versión.',
        'En Firefox, abre about:addons, pulsa ⚙ › «Instalar complemento desde archivo…» y elige el .xpi (o arrástralo a la ventana de Firefox).',
        'Pulsa «Añadir». Si luego falta el acceso a todas las webs, dalo como explica «Permiso de acceso», más arriba.',
        'Empareja con el código.',
      ],
      notes: [
        'El .xpi está firmado por Mozilla, así que Firefox la conserva al reiniciarse.',
        'Para actualizarla, instala el .xpi nuevo de la misma forma. El emparejamiento se mantiene.',
        'Si la versión no trae .xpi: descarga Centrate-extension-firefox.zip (el de Firefox, no el de Chrome), descomprímelo y, en about:debugging › Este Firefox, pulsa «Cargar complemento temporal…» y elige el manifest.json de esa carpeta.',
        'Un complemento temporal desaparece al cerrar Firefox: tendrás que cargarlo otra vez cada vez que lo abras. Después de cargarlo, abre about:addons › Céntrate y pon «Ejecutar en ventanas privadas» en «Permitir».',
      ],
    },
    hostPermission: {
      title: 'Permiso de acceso',
      granted: 'Permiso de acceso: concedido',
      missing: 'Permiso de acceso: falta',
      body: 'Para redirigir las webs bloqueadas, la extensión necesita acceso a todas las webs. Sin él, el navegador no aplica ningún bloqueo y no avisa.',
      grant: 'Dar permiso',
      grantHelp: 'El navegador te pedirá acceso a todas las webs',
      manual: 'Si el navegador no te lo pide, dalo a mano:',
      firefoxSteps: [
        'Abre about:addons y entra en Céntrate.',
        'En la pestaña «Permisos», activa el acceso a tus datos de todos los sitios web.',
      ],
      chromiumSteps: [
        'Abre la página de extensiones y pulsa «Detalles» en Céntrate.',
        'En «Acceso al sitio», elige «En todos los sitios».',
      ],
    },
    incognito: {
      title: 'Incógnito y ventanas privadas',
      /** «Incógnito: permitido», «InPrivate: no permitido», «Ventanas privadas: permitidas». */
      state: (family: BrowserFamily | null, allowed: boolean): string => {
        const name = privateName(family);
        const label = name.charAt(0).toUpperCase() + name.slice(1);
        // «ventanas privadas» is feminine plural; «incógnito» and «InPrivate» name a mode.
        const value = name === 'ventanas privadas' ? 'permitidas' : 'permitido';
        return `${label}: ${allowed ? value : `no ${value}`}`;
      },
      body: 'Los navegadores no dejan entrar a las extensiones en las ventanas privadas hasta que lo permites. Si no lo haces, ahí no se bloquea nada.',
      browsers: INCOGNITO_BROWSERS,
    },
    privacy: {
      title: 'Privacidad: lo que ve la extensión',
      points: [
        'Mira la dirección de cada página que abres para compararla con tus bloqueos. Esa comprobación se hace dentro del navegador.',
        'Nunca envía tu historial de navegación.',
        'Solo cuando intentas abrir algo bloqueado, envía el dominio (por ejemplo, youtube.com, nunca la dirección completa) al guardián de Céntrate, que está en tu propio ordenador, para restar los puntos del intento.',
        'Cada 30 segundos le dice al guardián que sigue activa: la versión del navegador y de la extensión y si tiene los permisos. Nada de tus webs.',
        'Guarda en el navegador el emparejamiento y la última lista de bloqueos, para seguir bloqueando aunque el guardián no responda. La dirección de una página bloqueada solo queda en la memoria de la sesión y se borra al cerrar el navegador.',
        'No hay analíticas ni servidores de Céntrate: nada sale de tu ordenador.',
      ],
    },
    troubleshooting: {
      title: 'Si algo falla',
      items: [
        {
          term: 'Guardián no responde',
          detail:
            'Abre Céntrate: si el guardián está detenido, pulsa Reparar. Mientras tanto, la extensión mantiene los bloqueos que ya tenía hasta que terminen.',
        },
        {
          term: 'Código no válido o caducado',
          detail:
            'Pide otro con «Nuevo código» y escríbelo antes de 5 minutos. Tras 5 fallos, el código deja de valer.',
        },
        {
          term: 'El guardián no reconoce esta extensión',
          detail:
            'En Chrome, Edge y Brave el guardián solo acepta la extensión oficial. Instálala desde Centrate-extension.zip de la última versión.',
        },
        {
          term: 'El guardián no reconoce este navegador',
          detail:
            'El guardián comprueba que quien se empareja es un navegador. Si usas un navegador poco común o un proxy en este ordenador, prueba con Chrome, Edge, Brave o Firefox.',
        },
        {
          term: 'Emparejamiento de otro navegador',
          detail: 'Cada navegador se empareja por separado: empareja este con un código nuevo.',
        },
        {
          term: 'No se bloquea nada',
          detail:
            'Comprueba el permiso de acceso (arriba), que la extensión esté activada y, en ventanas privadas, que esté permitida.',
        },
      ],
      diagnosticsLabel: 'Datos para pedir ayuda',
      diagnostics: {
        version: 'Versión de la extensión',
        browser: 'Navegador',
        id: 'ID de la extensión',
        status: 'Estado',
        lastSync: 'Última sincronización',
        never: 'Nunca',
      },
    },
  },
};

export type PagesMessages = typeof PAGES_ES;
