/**
 * Every user-facing string of the website in Spanish (es-ES), the source language. The English
 * translation (copy.en.ts) has the same shape (type `Copy`); components get the right one with
 * `copyFor(Astro.url)` from ./locale.ts and never hardcode copy. The human-readable version, with the editorial rules and the open questions,
 * lives in docs/web/copy.md: keep both in sync.
 *
 * Conventions baked into the strings:
 * - Sentence case. Headlines (h1/h2, card titles, run-in titles) end with a period; labels
 *   (navigation, buttons, feature names, FAQ questions, table headers) do not.
 * - Typographic minus «−» for negative points, «» quotes, «…» ellipsis, 24-hour clock, es-ES
 *   numbers («1.240»). A number and its unit are joined by a no-break space (\u00a0).
 * - Placeholders look like {name}; fill them with `fill()`, which type-checks the keys.
 * - Inline markup (only where a component renders it with `inline()`): **bold**, `code`,
 *   [text](href).
 * - Footnote references use the ids of `notes`; their numbers follow the order of `notes`,
 *   which is the order in which they first appear on the home page.
 * - The only gradient text on the site is `scene.headline.gradient`.
 */

/** Section ids on the home page (anchors for the navigation, FAQ links and footnotes). */
const ids = {
  highlights: 'funciones',
  demo: 'prueba',
  scene: 'guardian',
  block: 'bloqueo',
  study: 'study-mode',
  progress: 'progreso',
  privacy: 'privacidad',
  numbers: 'numeros',
  more: 'mas-funciones',
  faq: 'preguntas',
  download: 'descargar',
  footnotes: 'notas',
} as const;

/** States the AppWindow mock can show. */
export const appWindowStates = [
  'idle',
  'typing',
  'confirm',
  'countdown',
  'study',
  'progress',
  'blocked-page',
] as const;
export type AppWindowState = (typeof appWindowStates)[number];

/** Footnotes of the home page, in order of first appearance. */
const notes = {
  admin:
    'En un ordenador del que eres administrador no existe un bloqueo 100\u00a0% imposible de saltar. Céntrate te lo pone lo más difícil posible, sin esconderse y sin impedir nunca que lo desinstales.',
  attempts:
    'Si repites un intento en menos de 5\u00a0minutos, la penalización se duplica (−10, −20, −40…) hasta un máximo de −80\u00a0puntos por intento. Si varias capas detectan el mismo servicio a la vez, o vuelve a aparecer en menos de 30\u00a0segundos, cuenta como un solo intento. El saldo puede quedar en negativo.',
  webcam:
    'El Study Mode con cámara necesita una webcam. Sin ella puedes usar el Study Mode sin cámara, que solo tiene en cuenta la app o la web que tienes delante y tu actividad con el teclado y el ratón.',
  blockedPage:
    'La página de bloqueo, con tu motivo y los puntos que pierdes, necesita la extensión de Céntrate para Chrome, Edge, Brave o Firefox. Sin ella, el guardián bloquea igual en todo el sistema, pero el navegador solo te dirá que la web no carga.',
  emergency:
    'El desbloqueo de emergencia cuesta 200\u00a0puntos o la mitad de tu saldo, la cifra que sea mayor, además de tu racha. La espera se puede cancelar. No existe en Hardcore ni en el modo examen.',
  punishment:
    'El castigo dura 60\u00a0minutos por defecto (de 15 a 120 en Ajustes) y bloquea todas tus distracciones; si quieres, puedes endurecerlo para dejar solo tus webs de estudio. Al empezar te resta 100\u00a0puntos, y cada strike, 15. Los descansos del Pomodoro y las pausas no cuentan.',
  rewards:
    'Los precios de la tienda de recompensas son un ejemplo. Los descansos ganados no se pueden canjear durante un bloqueo Hardcore, el modo examen ni un castigo.',
  unsigned:
    'Los instaladores aún no están firmados con un certificado, así que Windows y macOS muestran un aviso la primera vez. En la guía de instalación te explicamos cómo abrirlos y cómo comprobar su SHA-256.',
} as const;
export type FootnoteId = keyof typeof notes;

export const es = {
  ids,

  /** Strings shared by several components. */
  ui: {
    skipLink: 'Saltar al contenido',
    pause: 'Pausar',
    play: 'Reproducir',
    replay: 'Repetir',
    pauseVideo: 'Pausar el vídeo',
    playVideo: 'Reproducir el vídeo',
    replayVideo: 'Repetir el vídeo',
    prev: 'Tarjeta anterior',
    next: 'Tarjeta siguiente',
    gallery: 'Galería: {name}',
    cardPosition: 'Tarjeta {n} de {total}',
    copy: 'Copiar',
    copied: 'Copiado',
    copyAria: 'Copiar {what}',
    footnoteRef: 'Nota {n}',
    footnoteBack: 'Volver al texto',
    version: 'Versión {version}',
    versionFallback: 'Última versión',
    published: 'Publicada el {date}',
    size: 'Tamaño',
    notAvailable: 'No disponible',
    /** Durations: 45\u00a0min, 1\u00a0h, 1\u00a0h 30\u00a0min. */
    duration: {
      minutes: '{m}\u00a0min',
      hours: '{h}\u00a0h',
      hoursMinutes: '{h}\u00a0h {m}\u00a0min',
    },
  },

  nav: {
    ariaLabel: 'Principal',
    brand: 'Céntrate',
    brandAria: 'Céntrate, ir al inicio',
    links: [
      { label: 'Funciones', href: `/#${ids.highlights}` },
      { label: 'Study Mode', href: `/#${ids.study}` },
      { label: 'Privacidad', href: `/#${ids.privacy}` },
    ],
    cta: 'Descargar',
    ctaAria: 'Descargar Céntrate',
    menuOpen: 'Abrir menú',
    menuClose: 'Cerrar menú',
  },

  /**
   * Language: the switch in the bar and the footer names the other language in that language
   * (lib/i18n.ts, `langNames`); `hint` is the one-line banner offered on the other language's
   * pages to visitors whose browser prefers this one (it is shown in this language).
   */
  language: {
    hint: {
      text: 'Ver esta página en español',
      dismiss: 'Cerrar',
      dismissAria: 'Cerrar el aviso de idioma',
    },
  },

  hero: {
    eyebrow: 'Céntrate',
    headline: 'Escríbelo. Y olvídate.',
    /** Optional subtitle, only if the layout needs one. */
    lead: 'Escribe qué quieres evitar y durante cuánto, y Céntrate lo bloquea aunque cierres la app.',
    /** Button and small line under it, by detected system. Linux downloads the .deb. */
    cta: {
      windows: {
        label: 'Descargar gratis para Windows',
        note: 'Gratis y sin cuenta. Windows 10 y 11.',
      },
      mac: {
        label: 'Descargar gratis para macOS',
        note: 'Gratis y sin cuenta. Apple Silicon e Intel.',
      },
      linux: {
        label: 'Descargar gratis para Linux',
        note: 'Gratis y sin cuenta. Paquete .deb para Ubuntu y Debian.',
      },
      /** Phones, tablets and unknown systems: the button goes to /descargar. */
      other: {
        label: 'Ver las descargas',
        note: 'Céntrate es para ordenador: Windows, macOS y Linux.',
      },
    },
    otherSystems: { label: 'Otros sistemas', href: '/descargar' },
    visualAria:
      'La ventana de Céntrate: en el campo «¿Qué quieres hacer?» se escribe «no veo YouTube en una hora», se confirma con Enter y empieza una cuenta atrás de una hora.',
  },

  highlights: {
    id: ids.highlights,
    headline: 'Lo más destacado.',
    pause: 'Pausar',
    resume: 'Reanudar',
    pauseAria: 'Pausar el avance automático',
    resumeAria: 'Reanudar el avance automático',
    cards: [
      {
        title: 'Escríbelo y listo.',
        text: 'Escribe «no veo YouTube en una hora» y pulsa Enter dos veces: una para revisarlo y otra para bloquear.',
      },
      {
        title: 'Sigue bloqueado aunque cierres la app.',
        text: 'Ciérrala, termínala desde el Administrador de tareas o reinicia el ordenador: el bloqueo dura hasta el último minuto.',
        note: 'admin' satisfies FootnoteId,
      },
      {
        title: 'Cada intento te cuesta 10\u00a0puntos.',
        text: 'No llegas a entrar. Y si lo vuelves a intentar en menos de 5\u00a0minutos, el siguiente cuesta el doble.',
        note: 'attempts' satisfies FootnoteId,
      },
      {
        title: 'El Study Mode te ve estudiar.',
        text: 'Una IA que funciona en tu ordenador nota si coges el móvil o te vas, y antes de nada te pregunta si sigues ahí.',
        note: 'webcam' satisfies FootnoteId,
        /** The dark card that carries the video. */
        dark: true,
      },
    ],
  },

  demo: {
    id: ids.demo,
    headline: 'Pruébalo sin instalar nada.',
    lead: 'Escribe lo que quieres evitar, como lo dirías tú, y mira lo que haría Céntrate.',
    /** Language of the parser, when it is not the page's (empty here: it is Spanish). */
    languageNote: '',
    label: '¿Qué quieres hacer?',
    inputHint: 'Por ejemplo, «no veo YouTube en una hora».',
    clear: 'Borrar',
    examplesLabel: 'Prueba con',
    /**
     * The first six come from the brief; all of them rotate as placeholder every 4 s. They are
     * parser input, so they keep plain spaces (no \u00a0).
     */
    examples: [
      'no veo YouTube en una hora',
      'nada de TikTok ni Instagram durante 45 minutos',
      'bloquea las redes sociales hasta las 20:30',
      'sin juegos hora y media',
      'no quiero ver Netflix 2h',
      'estudiar mates 1 hora',
      'sin insta media hora',
      'nada de Discord hasta mañana a las 8',
      'no veo series 1h30',
    ],
    result: {
      title: 'Esto haría Céntrate',
      /** {services} is an es-ES list (Intl.ListFormat): «TikTok e Instagram». */
      block: 'Céntrate bloquearía {services} durante {duration}, hasta las {time}.',
      blockUntil: 'Céntrate bloquearía {services} hasta las {time} ({duration}).',
      /** Replaces a service in {services} when the phrase names a category. */
      category: 'toda la categoría {category}',
      mode: 'En modo Normal: después solo se podría ampliar, nunca acortar.',
      study: 'Céntrate te propondría un Study Mode de {duration} con la tarea «{task}».',
      studyNoTask: 'Céntrate te propondría un Study Mode de {duration}.',
      over4h: 'Son más de 4\u00a0horas: la app te pediría confirmarlo dos veces.',
      over24h: 'El máximo es 24\u00a0horas por bloqueo.',
      partial:
        'He entendido {understood}, pero no «{rest}». En la app se abriría el formulario avanzado con eso ya puesto.',
      none: 'No he entendido «{text}». La app no se inventaría nada: abriría el formulario avanzado para que lo elijas tú.',
      tryHint: 'Prueba con un servicio y un tiempo, como «no quiero ver Netflix 2h».',
      empty: 'Escribe una frase o elige un ejemplo.',
      /** Joins the fragments of {rest} in `partial`. */
      restSeparator: '», «',
      /** Chips under the field and the «Termina a las» value; {date} is «30/9». */
      untilToday: 'hasta {time}',
      untilTomorrow: 'hasta mañana {time}',
      untilDate: 'hasta el {date} {time}',
      endsToday: '{time}',
      endsTomorrow: 'mañana {time}',
      endsDate: 'el {date} {time}',
      /** Category names, as in the catalog of @centrate/shared. */
      categoryNames: {
        social: 'Redes sociales',
        video: 'Vídeo y streaming',
        games: 'Juegos',
        messaging: 'Mensajería',
        shopping: 'Compras',
        news: 'Noticias y deportes',
      },
      fields: {
        what: 'Qué se bloquea',
        duration: 'Duración',
        ends: 'Termina a las',
        mode: 'Modo',
      },
      defaultMode: 'Normal',
    },
    note: 'Es una demostración: aquí no se bloquea nada. Entiende las frases igual que la app, y lo que escribes no sale de esta página.',
  },

  scene: {
    id: ids.scene,
    /** Only `gradient` gets the gradient treatment, here and on the whole site. */
    headline: { lead: 'Ciérrala.', gradient: 'Sigue funcionando.' },
    lead: 'Los bloqueos los aplica el guardián, un pequeño servicio del sistema que instala Céntrate. Funciona con la app cerrada, después de reiniciar y aunque cambies la hora, y se quita solo cuando se acaba el tiempo.',
    leadNote: 'admin' satisfies FootnoteId,
    beats: [
      {
        title: 'Cierras Céntrate.',
        text: 'Con la X, con «Salir» o desde el Administrador de tareas. La ventana se va; el bloqueo, no.',
      },
      {
        title: 'Abres youtube.com.',
        text: 'Por costumbre, casi sin pensarlo.',
      },
      {
        title: 'No carga. Y te cuesta 10\u00a0puntos.',
        text: 'En su lugar ves tu motivo, «Quiero aprobar mates», y lo que te ha costado el intento.',
        note: 'blockedPage' satisfies FootnoteId,
      },
    ],
    /** Generic browser in the animation. */
    browser: {
      address: 'youtube.com',
      tabLoading: 'youtube.com',
      tabBlocked: 'Bloqueado · Céntrate',
    },
    /** Screen readers and the reduced-motion (static) version. */
    summary:
      'Animación en tres pasos: se cierra la ventana de Céntrate, un navegador intenta abrir youtube.com y, en su lugar, aparece la página de bloqueo de Céntrate con el motivo «Quiero aprobar mates» y −10\u00a0puntos.',
  },

  chapters: {
    block: {
      id: ids.block,
      eyebrow: 'Bloqueo',
      headline: 'Tú pones la frase. Céntrate pone el límite.',
      lead: 'Escribe «nada de TikTok ni Instagram durante 45\u00a0minutos» y Céntrate entiende qué bloquear, cuánto y hasta qué hora. Lo confirmas con Enter y, desde ese momento, solo se puede ampliar.',
      cards: [
        {
          title: 'Escribe como hablas.',
          text: 'Entiende «yt», «insta», «hora y media» o «hasta mañana a las 8», sin necesidad de internet.',
          visual: 'typing' satisfies AppWindowState,
        },
        {
          title: 'Tú confirmas.',
          text: 'Una tarjeta te enseña qué se bloquea, cuánto dura y a qué hora termina, y lo que no entiende no se lo inventa.',
          visual: 'confirm' satisfies AppWindowState,
        },
        {
          title: 'Webs y apps a la vez.',
          text: 'Bloquea webs en el navegador y cierra apps como Steam, Discord o Roblox si intentas abrirlas.',
        },
        {
          title: 'Solo se puede ampliar.',
          text: 'Añade 15\u00a0minutos, media hora o una hora con un clic; para acortar no hay botón.',
          visual: 'countdown' satisfies AppWindowState,
        },
        {
          title: 'Salir antes tiene un precio.',
          text: 'Escribes a mano una frase de compromiso, esperas 10\u00a0minutos (30 en Estricto) y pierdes al menos 200\u00a0puntos y tu racha; en Hardcore, no hay salida.',
          note: 'emergency' satisfies FootnoteId,
        },
      ],
    },
    study: {
      id: ids.study,
      eyebrow: 'Study Mode',
      headline: 'Mirar el cuaderno es estudiar. El móvil, no.',
      lead: 'Di qué vas a estudiar y enciende la cámara. Una IA que funciona en tu ordenador comprueba si estás estudiando: si no, te avisa, y si sigues sin estudiar, bloquea tus distracciones durante una hora.',
      leadNote: 'webcam' satisfies FootnoteId,
      cards: [
        {
          title: 'Hecho a tu medida.',
          text: 'Una calibración de unos 2\u00a0minutos le enseña cómo estudias tú: mirando la pantalla, con un libro o con un cuaderno.',
        },
        {
          title: 'Primero pregunta.',
          text: 'Si te despistas 15\u00a0segundos, te pregunta «¿Sigues ahí?», y si sigues así 30\u00a0segundos más, es un strike y pierdes 15\u00a0puntos.',
          visual: 'study' satisfies AppWindowState,
        },
        {
          title: 'Aprende de sus errores.',
          text: 'Si te avisa sin motivo, pulsa «¡Estaba estudiando!» y lo tendrá en cuenta la próxima vez.',
        },
        {
          title: 'Tres strikes, una hora sin distracciones.',
          text: 'Al tercer strike, el guardián bloquea tus distracciones durante 60\u00a0minutos, aunque cierres la app.',
          note: 'punishment' satisfies FootnoteId,
        },
        {
          title: 'También sin cámara.',
          text: 'Si no tienes cámara o prefieres no usarla, el Study Mode se fija en la app que tienes delante y en tu actividad con el teclado y el ratón.',
        },
      ],
    },
    progress: {
      id: ids.progress,
      eyebrow: 'Progreso',
      headline: 'Cada minuto suma. Cada intento resta.',
      lead: 'Los puntos salen de lo que pasa de verdad: los minutos que cumples suman y los intentos y los strikes restan. Gástalos en descansos, cuida tu racha y mira cómo crece tu mascota.',
      cards: [
        {
          title: 'Así se ganan.',
          text: '+1\u00a0punto por minuto de bloqueo cumplido, +2 por minuto concentrado en Study Mode y +20 si terminas una sesión sin ningún intento.',
          visual: 'progress' satisfies AppWindowState,
        },
        {
          title: 'Descansos ganados.',
          text: 'Canjea tus puntos por tiempo libre sin penalización, como 15\u00a0minutos de YouTube por 150\u00a0puntos.',
          note: 'rewards' satisfies FootnoteId,
        },
        {
          title: 'Una racha que cuidar.',
          text: 'Cada día que llegas a tu objetivo, 60\u00a0minutos concentrado si no lo cambias, tu racha suma un día.',
        },
        {
          title: 'Una mascota que crece contigo.',
          text: 'Pasa de brote a planta y de planta a árbol mientras te concentras, y se marchita si te rindes.',
        },
        {
          title: 'Puntos que nadie puede tocar.',
          text: 'Salen del registro del guardián, no se pueden editar en ningún sitio y el saldo puede quedar en números rojos.',
        },
      ],
    },
  },

  privacy: {
    id: ids.privacy,
    headline: 'Tu cámara no sale de tu ordenador.',
    body: [
      'El Study Mode analiza la imagen en tu ordenador, unas pocas veces por segundo y a baja resolución, y la descarta al momento. No sabe quién eres: solo si hay alguien, hacia dónde mira y si hay un móvil o un libro.',
      'La cámara solo se enciende cuando empiezas una sesión, y mientras está encendida ves siempre el aviso «Cámara activa». Y como el código es abierto, cualquiera puede comprobarlo.',
    ],
    points: [
      {
        title: 'No se guarda ninguna imagen.',
        text: 'Ni fotos ni vídeo: solo números, como los minutos que has estado concentrado.',
      },
      {
        title: 'Todo se procesa en tu ordenador.',
        text: 'La IA va dentro de la app y funciona sin internet.',
      },
      {
        title: 'Sin cuenta y sin cookies de seguimiento.',
        text: 'Ni en la app ni en esta web.',
      },
    ],
    link: { label: 'Lee la política de privacidad', href: '/privacidad' },
  },

  numbers: {
    id: ids.numbers,
    /** Accessible name of the section, which has no visible heading. */
    ariaLabel: 'Céntrate en números',
    items: [
      {
        headline: '−10\u00a0puntos por cada intento.',
        text: 'Si repites en menos de 5\u00a0minutos, se duplica: −20, −40, hasta −80.',
        note: 'attempts' satisfies FootnoteId,
      },
      {
        headline: '60\u00a0minutos de castigo si no estudias.',
        text: 'Al tercer strike de una sesión, el guardián bloquea tus distracciones durante una hora. Cerrar la app no lo quita.',
        note: 'punishment' satisfies FootnoteId,
      },
      {
        headline: '+2\u00a0puntos por cada minuto concentrado.',
        text: 'El doble que un minuto de bloqueo. Estudia 75\u00a0minutos y te habrás ganado 15 de YouTube.',
        note: 'rewards' satisfies FootnoteId,
      },
    ],
  },

  more: {
    id: ids.more,
    headline: 'Y mucho más.',
    /** Name (label, no period) under an 80 px icon, then one sentence. */
    items: [
      {
        name: 'Pomodoro',
        text: '25/5, 50/10 o a tu medida, y en los descansos la cámara no vigila.',
      },
      {
        name: 'Horarios',
        text: 'Bloqueos que se repiten solos, como las redes sociales de lunes a viernes de 16:00 a 19:00.',
      },
      {
        name: 'Modo examen',
        text: 'Solo tus webs de estudio y sin forma de cancelarlo hasta la hora que elijas.',
      },
      {
        name: 'Estadísticas',
        text: 'Tu tiempo concentrado por día, semana y mes, con mapa de calor y exportación a CSV.',
      },
      {
        name: 'Sonidos',
        text: 'Lluvia, ruido blanco o lo-fi, incluidos en la app y sin internet.',
      },
      {
        name: 'Mini temporizador',
        text: 'Una cuenta atrás pequeña y siempre visible que colocas donde quieras.',
      },
      {
        name: 'Extensión del navegador',
        text: 'Para Chrome, Edge, Brave y Firefox: bloquea al instante y te enseña tu motivo.',
      },
      {
        name: 'Tu motivo',
        text: 'Una frase tuya, como «Quiero aprobar mates», que aparece justo cuando intentas entrar.',
      },
      {
        name: 'Recordatorios',
        text: '«Es tu hora de estudiar» según tus horarios, y descansos para la vista con la regla 20-20-20.',
      },
      {
        name: 'Logros',
        text: 'Tu primera sesión, 7\u00a0días de racha, 10\u00a0horas de Study Mode, una semana sin intentos…',
      },
    ],
    /** Replacements if a tile has to change. */
    spare: [
      {
        name: 'Plantillas rápidas',
        text: 'Deberes 1\u00a0h, Examen 3\u00a0h o Leer 30\u00a0min: un clic y Enter.',
      },
      {
        name: 'Tareas de la sesión',
        text: 'Apunta qué vas a hacer y, al terminar, di si lo has conseguido.',
      },
    ],
  },

  faq: {
    id: ids.faq,
    headline: 'Preguntas frecuentes.',
    /** Answers may contain inline markup (links). */
    items: [
      {
        q: '¿Céntrate es gratis?',
        a: 'Sí, del todo: sin anuncios, sin cuenta y sin versión de pago. Es de código abierto, con licencia MIT, y puedes leer todo el código en GitHub.',
      },
      {
        q: '¿Se puede saltar un bloqueo?',
        a: 'Cerrar la app, terminarla desde el Administrador de tareas, reiniciar o cambiar la hora del ordenador no lo quitan. Aun así, seamos claros: en un ordenador del que eres administrador, ningún bloqueo es 100\u00a0% imposible de saltar. Céntrate te lo pone difícil y te cobra cada intento, porque está pensado para ayudarte a ti, no para encerrar a nadie.',
      },
      {
        q: '¿Y si de verdad necesito entrar?',
        a: 'En Normal y en Estricto tienes el desbloqueo de emergencia: escribes a mano «Acepto romper mi compromiso y perder mis puntos», esperas 10\u00a0minutos (30 en Estricto) y pierdes 200\u00a0puntos o la mitad de tu saldo, lo que sea más, además de tu racha. En Hardcore y en el modo examen no hay forma de cancelarlo, y Céntrate te lo avisa antes de confirmar.',
      },
      {
        q: '¿La cámara graba o envía algo?',
        a: 'No. Solo se enciende cuando empiezas el Study Mode, y mientras está encendida ves siempre el aviso «Cámara activa». Las imágenes se analizan en tu ordenador y se descartan al momento: ninguna se guarda, se sube ni sale del dispositivo. Si prefieres no usarla, hay un Study Mode sin cámara.',
      },
      {
        q: '¿Y si tapo la cámara o cierro la app en pleno Study Mode?',
        a: 'Tapar la cámara cuenta como que no estás, y al minuto suma un strike. Si cierras la app a la fuerza, a los 2\u00a0minutos cuenta como abandono y empieza el castigo. Los descansos del Pomodoro y las pausas no cuentan.',
      },
      {
        q: '¿Funciona sin internet?',
        a: 'Sí. Los bloqueos, los puntos y el Study Mode funcionan sin conexión, porque la IA va dentro de la app. Si hay internet, Céntrate solo lo usa para buscar actualizaciones en GitHub y comprobar que nadie ha adelantado el reloj.',
      },
      {
        q: '¿Por qué pide permiso de administrador?',
        a: 'Para instalar el guardián, el servicio del sistema que mantiene los bloqueos con la app cerrada. Lo pide una sola vez, y el guardián solo toca el archivo hosts, las apps de tu lista y su propia carpeta.',
      },
      {
        q: '¿Necesito la extensión? ¿Funciona en incógnito?',
        a: 'La extensión bloquea al instante en Chrome, Edge, Brave y Firefox, y te enseña la página de bloqueo con tu motivo. Sin ella, el guardián bloquea igual en todo el sistema, pero una web que ya estaba abierta puede tardar en cortarse. En incógnito solo funciona si se lo permites en los ajustes de la extensión; Céntrate lo detecta y te explica cómo hacerlo.',
      },
      {
        q: 'Windows o macOS me avisan al abrirlo. ¿Es normal?',
        a: 'Sí. Los instaladores aún no están firmados con un certificado, que cuesta dinero cada año, así que el sistema no reconoce al autor. En Windows, pulsa «Más información» y después «Ejecutar de todas formas». En macOS, ve a Ajustes del Sistema → Privacidad y seguridad y pulsa «Abrir igualmente». Si quieres, [comprueba antes su SHA-256](/descargar#sha256).',
      },
      {
        q: '¿Por qué mi antivirus avisa del archivo hosts?',
        a: 'Porque Céntrate bloquea webs escribiendo en ese archivo, siempre dentro de su propia sección y con una copia previa, y algunos antivirus lo vigilan. Si el tuyo lo frena, permite el cambio para Céntrate: [los pasos están en la guía](/descargar#antivirus).',
      },
      {
        q: '¿Sirve como control parental?',
        a: 'No está hecho para eso. Céntrate ayuda a quien quiere concentrarse: no se esconde, su icono siempre está en la bandeja y se puede desinstalar cuando se quiera. Si lo va a usar tu hijo o tu hija, lo mejor es instalarlo juntos y que elija sus propios bloqueos.',
      },
      {
        q: '¿Cómo lo desinstalo?',
        a: 'Como cualquier programa y cuando quieras, también con un bloqueo activo: en ese caso, antes te avisa de que perderás los puntos y la racha. Al desinstalar se quitan el guardián, sus líneas del archivo hosts y todo lo que instaló. [Pasos para cada sistema](/descargar#desinstalar).',
      },
    ],
  },

  /** Final download block of the home page (dark section). */
  download: {
    id: ids.download,
    headline: 'Céntrate es gratis.',
    lead: 'Sin cuenta, sin anuncios y de código abierto.',
    /** Keys match the assets in src/lib/downloads.ts; `file` is shown under the label. */
    buttons: {
      windows: { label: 'Descargar para Windows', file: 'Centrate-Setup.exe' },
      mac: { label: 'Descargar para macOS', file: 'Centrate.dmg' },
      deb: { label: 'Descargar para Linux (.deb)', file: 'Centrate.deb' },
      appImage: { label: 'Descargar para Linux (AppImage)', file: 'Centrate.AppImage' },
    },
    extension: {
      label: 'Extensión para Chrome, Edge y Brave',
      file: 'Centrate-extension.zip',
    },
    requirementsTitle: 'Requisitos',
    requirements: [
      'Windows 10 u 11 de 64\u00a0bits.',
      'macOS 12 o posterior, con Apple Silicon o Intel.',
      'Ubuntu o Debian de 64\u00a0bits (.deb), u otra distribución de 64\u00a0bits (AppImage).',
      'Permiso de administrador una vez, para instalar el guardián.',
      'Chrome, Edge, Brave o Firefox, para la extensión.',
      'Una webcam, solo para el Study Mode con cámara.',
    ],
    unsigned: {
      text: 'Windows y macOS mostrarán un aviso la primera vez que lo abras.',
      note: 'unsigned' satisfies FootnoteId,
    },
    guide: { label: 'Guía de instalación', href: '/descargar' },
    changelog: { label: 'Novedades', href: '/novedades' },
  },

  footnotes: {
    id: ids.footnotes,
    /** Visually hidden heading of the notes list. */
    title: 'Notas',
    items: notes,
  },

  footer: {
    links: {
      download: { label: 'Descargar', href: '/descargar' },
      changelog: { label: 'Novedades', href: '/novedades' },
      privacy: { label: 'Privacidad', href: '/privacidad' },
      /** External: URLs come from src/lib/site.ts. */
      source: { label: 'Código fuente' },
      issues: { label: 'Informar de un problema' },
    },
    license: 'Céntrate es software libre con licencia MIT.',
    cookies: 'Esta web no usa cookies.',
    trademarks:
      'YouTube, Windows, macOS y el resto de marcas citadas pertenecen a sus propietarios. Céntrate no está afiliado a ninguna de ellas.',
    copyright: '© 2026 Imdlodoem23 y colaboradores de Céntrate.',
  },

  /**
   * Literal texts of the Céntrate window mock (brief, section 10). Sample data that adds up:
   * the block was confirmed at 16:42 for 1\u00a0h and the countdown moment is 16:59:42.
   */
  appWindow: {
    title: {
      idle: 'Céntrate',
      blocked: 'Céntrate · quedan 42\u00a0min',
      study: 'Céntrate · estudiando',
    },
    block: {
      idleHeader: 'Bloqueo: ninguno',
      idleMeta: 'Próximo horario: 16:00',
      field: '¿Qué quieres hacer?',
      typed: 'no veo YouTube en una hora',
      chips: ['YouTube', '1\u00a0h', 'hasta 17:42'],
      templates: ['Deberes 1\u00a0h', 'Examen 3\u00a0h', 'Leer 30\u00a0min', 'Más…'],
      idleHelp: 'Escribe lo que quieres evitar y pulsa Enter.',
      confirm: {
        what: 'YouTube',
        duration: '1\u00a0h',
        ends: 'termina a las 17:42',
        modes: ['Normal', 'Estricto', 'Hardcore', 'Examen'],
        selectedMode: 'Normal',
        help: 'Normal: la emergencia tarda 10\u00a0min y cuesta al menos 200\u00a0puntos',
        motiveLabel: 'Tu motivo',
        motive: 'Quiero aprobar mates',
        reminder: 'Solo se puede ampliar, nunca acortar',
        edit: 'Editar…',
        submit: 'Bloquear hasta 17:42',
      },
      activeHeader: 'Bloqueo: YouTube · Normal',
      activeMeta: 'hasta 17:42',
      newPill: 'Nuevo',
      /** Minutes and seconds apart: seconds render at 60\u00a0% opacity. */
      countdown: { minutes: '42', seconds: ':18' },
      countdownAria: 'Quedan 42\u00a0minutos',
      motive: 'Quiero aprobar mates',
      extend: ['+15\u00a0min', '+30\u00a0min', '+1\u00a0h', 'Otro…'],
      emergency: 'Desbloqueo de emergencia…',
      folded: 'Bloqueo: YouTube · 42\u00a0min',
    },
    study: {
      readyHeader: 'Study Mode: listo',
      readyMeta: 'Con cámara · calibrado',
      presets: ['25/5', '50/10', '1\u00a0h', 'Más…'],
      activeHeader: 'Study Mode: historia · 32:10',
      cameraPill: 'Cámara activa',
      meter: 'Concentrado',
      strikesAria: 'Strikes: 0 de 3',
      tiles: ['Pausa (2)', 'Sonido: Lluvia', 'Vista previa', 'Terminar'],
    },
    progress: {
      header: 'Nivel 7 · 1.240\u00a0puntos',
      meta: 'Racha: 5\u00a0días',
      goal: 'Hoy: 42 de 60\u00a0min',
      tiles: ['Estadísticas…', 'Recompensas…', 'Logros…'],
    },
    footer: {
      guardian: 'Guardián activo',
      extension: 'Extensión conectada',
      version: 'v{version}',
      buttons: ['Mini temporizador', 'Ajustes…', 'Salir'],
    },
    blockedPage: {
      header: 'YouTube: bloqueado',
      meta: 'quedan 42\u00a0min',
      motive: 'Quiero aprobar mates',
      points: '−10\u00a0puntos',
      quip: 'YouTube seguirá ahí dentro de 42\u00a0minutos. Tus deberes, no.',
      back: 'Volver a lo mío',
    },
    /** Accessible name per state, for role="img". */
    aria: {
      idle: 'Ventana de Céntrate en reposo, con el campo «¿Qué quieres hacer?» y las plantillas Deberes 1\u00a0h, Examen 3\u00a0h y Leer 30\u00a0min.',
      typing:
        'Ventana de Céntrate con «no veo YouTube en una hora» escrito en el campo. La app ha entendido YouTube, 1\u00a0hora, hasta las 17:42.',
      confirm:
        'Tarjeta de confirmación de Céntrate: bloquear YouTube durante 1\u00a0hora, hasta las 17:42, en modo Normal y con el motivo «Quiero aprobar mates».',
      countdown:
        'Ventana de Céntrate con YouTube bloqueado hasta las 17:42. Quedan 42\u00a0minutos.',
      study:
        'Ventana de Céntrate en Study Mode, estudiando historia, con la cámara activa y el medidor en «Concentrado».',
      progress:
        'Progreso en Céntrate: nivel 7, 1.240\u00a0puntos, racha de 5\u00a0días y 42 de 60\u00a0minutos hoy.',
      'blocked-page':
        'Página de bloqueo de Céntrate: YouTube bloqueado, quedan 42\u00a0minutos, motivo «Quiero aprobar mates» y −10\u00a0puntos.',
    } satisfies Record<AppWindowState, string>,
  },

  pages: {
    descargar: {
      headline: 'Descarga Céntrate.',
      lead: 'Gratis, sin cuenta y de código abierto. Elige tu sistema y sigue los pasos: son unos minutos.',
      versionFallback: 'Última versión disponible en GitHub.',
      mobileNote: 'Céntrate es para ordenador. Abre esta página desde tu Windows, macOS o Linux.',
      tocLabel: 'En esta página',
      windows: {
        id: 'windows',
        toc: 'Windows',
        headline: 'Instalar en Windows.',
        requirement: 'Windows 10 u 11 de 64\u00a0bits.',
        button: 'Descargar Centrate-Setup.exe',
        steps: [
          'Descarga **Centrate-Setup.exe** y ábrelo.',
          'Si aparece «Windows protegió su PC», pulsa **Más información** y después **Ejecutar de todas formas**.',
          'Cuando Windows pregunte si quieres permitir que la app haga cambios en el dispositivo, pulsa **Sí**. Es la única vez que te pide permiso de administrador, y sirve para instalar el guardián.',
          'Termina el instalador y abre Céntrate. Su icono aparece en la bandeja del sistema, junto al reloj; si no lo ves, pulsa la flecha de los iconos ocultos.',
          'Sigue la bienvenida: instala la extensión, prueba la cámara si quieres y crea tu primer bloqueo.',
        ],
        notes: ['En Windows, Céntrate se actualiza solo cuando sale una versión nueva.'],
      },
      macos: {
        id: 'macos',
        toc: 'macOS',
        headline: 'Instalar en macOS.',
        requirement: 'macOS 12 o posterior. Una sola descarga para Apple Silicon e Intel.',
        button: 'Descargar Centrate.dmg',
        steps: [
          'Descarga **Centrate.dmg**, ábrelo y arrastra Céntrate a la carpeta **Aplicaciones**.',
          'Abre Céntrate desde Aplicaciones. macOS avisará de que no puede comprobar la app: cierra el aviso sin moverla a la Papelera.',
          'Ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta **Seguridad** y pulsa **Abrir igualmente** junto al mensaje sobre Céntrate. Confírmalo con tu contraseña. El botón solo aparece durante un rato después de intentar abrir la app.',
          'La primera vez, Céntrate te pide la contraseña de administrador para instalar el guardián. Solo lo hace una vez.',
          'Si vas a usar el Study Mode con cámara, permite el acceso a la cámara cuando te lo pida.',
        ],
        notes: [
          'Opcional: con el permiso de **Grabación de pantalla**, Céntrate también detecta cuándo tienes delante algo bloqueado. Solo lee el título de la ventana activa y no graba nada. Sin ese permiso, todo lo demás funciona igual.',
          'En macOS, Céntrate no se actualiza solo: cuando hay una versión nueva, te avisa y te trae a esta página.',
        ],
      },
      linux: {
        id: 'linux',
        toc: 'Linux',
        headline: 'Instalar en Linux.',
        requirement:
          'Ubuntu o Debian de 64\u00a0bits. La AppImage sirve para otras distribuciones.',
        deb: {
          title: 'Paquete .deb',
          text: 'Recomendado en Ubuntu y Debian.',
          button: 'Descargar Centrate.deb',
          steps: [
            'Descarga **Centrate.deb**.',
            'Instálalo con doble clic desde tu gestor de software o, en una terminal abierta en la carpeta de descargas, con `sudo apt install ./Centrate.deb`.',
            'El guardián se instala y arranca solo. Abre Céntrate desde el menú de aplicaciones.',
          ],
        },
        appImage: {
          title: 'AppImage',
          text: 'Para otras distribuciones de 64\u00a0bits.',
          button: 'Descargar Centrate.AppImage',
          steps: [
            'Descarga **Centrate.AppImage**.',
            'Dale permiso de ejecución en Propiedades → **Permitir ejecutar como programa**, o con `chmod +x Centrate.AppImage`.',
            'Ábrelo. La primera vez te pedirá tu contraseña para instalar el guardián.',
          ],
        },
        notes: [
          'Si la AppImage no se abre, instala FUSE 2: `sudo apt install libfuse2t64` en Ubuntu 24.04 o posterior, o `sudo apt install libfuse2` en versiones anteriores.',
        ],
      },
      extension: {
        id: 'extension',
        toc: 'Extensión',
        headline: 'Instalar la extensión.',
        lead: 'La extensión bloquea al instante dentro del navegador y te enseña la página de bloqueo con tu motivo. Sin ella, el bloqueo del sistema sigue activo, pero una web puede tardar en dejar de cargar. Instálala en cada navegador que uses.',
        chromium: {
          title: 'Chrome, Edge y Brave',
          text: 'De momento se instala a mano, como extensión descomprimida. Son un par de minutos.',
          button: 'Descargar Centrate-extension.zip',
          steps: [
            'Descarga **Centrate-extension.zip** y descomprímelo en una carpeta que no vayas a mover ni borrar, por ejemplo en Documentos.',
            'Abre la página de extensiones: `chrome://extensions` en Chrome, `edge://extensions` en Edge o `brave://extensions` en Brave.',
            'Activa el **Modo de desarrollador**.',
            'Pulsa **Cargar descomprimida** (en Edge, **Cargar desempaquetada**) y elige la carpeta.',
            'Escribe el código de emparejamiento que te enseña Céntrate en la bienvenida o en **Ajustes… → Sistema**.',
            'Para que funcione también en incógnito, pulsa **Detalles** en la extensión y activa **Permitir en modo incógnito** (en Edge, **Permitir en InPrivate**).',
          ],
          notes: [
            'No borres ni muevas la carpeta: el navegador carga la extensión desde ahí.',
            'Es normal que el navegador te recuerde que tienes extensiones en modo de desarrollador. No la desactives.',
            'Para actualizarla, sustituye el contenido de la carpeta por el de la versión nueva y pulsa el botón de recargar de la extensión.',
          ],
        },
        firefox: {
          title: 'Firefox',
          button: 'Ver la última versión en GitHub',
          steps: [
            'Abre la última versión en GitHub y descarga el archivo que acaba en **.xpi**.',
            'Arrástralo a una ventana de Firefox y pulsa **Añadir**.',
            'Si te pide acceso a todos los sitios web, acéptalo: sin ese permiso no puede bloquear.',
            'Escribe el código de emparejamiento que te enseña Céntrate.',
            'Para las ventanas privadas, abre `about:addons` → Céntrate y, en **Ejecutar en ventanas privadas**, elige **Permitir**.',
          ],
          notes: [
            'Si la última versión aún no trae el archivo .xpi, la extensión para Firefox llegará en la próxima. Mientras tanto, el guardián bloquea igual en todo el sistema.',
          ],
        },
      },
      warnings: {
        id: 'avisos',
        toc: 'Avisos de seguridad',
        headline: 'Por qué aparece un aviso.',
        text: 'Firmar los instaladores con un certificado cuesta dinero cada año, y Céntrate aún no lo hace. Por eso Windows y macOS avisan la primera vez que lo abres. No significa que el archivo tenga nada malo, sino que el sistema no conoce al autor. El código es abierto y cada versión publica su SHA-256 para que compruebes que el archivo es el original.',
        items: [
          {
            label: 'Windows (SmartScreen)',
            text: '«Windows protegió su PC» → **Más información** → **Ejecutar de todas formas**.',
          },
          {
            label: 'macOS',
            text: '**Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**.',
          },
        ],
      },
      checksum: {
        id: 'sha256',
        toc: 'Comprobar la descarga',
        headline: 'Comprueba que es el original.',
        text: 'Cada versión publica el archivo **SHA256SUMS.txt** con la huella SHA-256 de cada descarga. Funciona como una huella dactilar: si cambia un solo byte del archivo, la huella cambia por completo. Calcula la de tu archivo y compárala con la publicada.',
        table: { file: 'Archivo', size: 'Tamaño', hash: 'SHA-256' },
        commands: [
          {
            label: 'Windows (PowerShell)',
            command: 'Get-FileHash .\\Centrate-Setup.exe -Algorithm SHA256',
          },
          { label: 'macOS (Terminal)', command: 'shasum -a 256 Centrate.dmg' },
          { label: 'Linux', command: 'sha256sum Centrate.deb' },
        ],
        sumsLink: 'Descargar SHA256SUMS.txt',
        mismatch: 'Si no coinciden, no lo abras: bórralo y descárgalo otra vez desde esta página.',
      },
      antivirus: {
        id: 'antivirus',
        toc: 'Antivirus',
        headline: 'Si tu antivirus avisa.',
        text: 'Céntrate bloquea webs escribiendo en el archivo hosts, siempre entre las líneas `# >>> CENTRATE START` y `# <<< CENTRATE END` y con una copia de seguridad previa. Algunos antivirus vigilan ese archivo.',
        items: [
          'En Windows, abre **Seguridad de Windows → Protección antivirus y contra amenazas → Historial de protección**, elige el aviso sobre el archivo hosts y pulsa **Acciones → Permitir en el dispositivo**.',
          'En otros antivirus, añade una excepción para el guardián de Céntrate (`centrate-guardian`).',
        ],
      },
      installs: {
        id: 'que-instala',
        toc: 'Qué se instala',
        headline: 'Qué instala Céntrate.',
        items: [
          '**La app**, que vive en la bandeja del sistema y siempre se ve.',
          '**El guardián**, un servicio del sistema que aplica los bloqueos aunque la app esté cerrada. Solo toca el archivo hosts, las apps que tú bloqueas y su propia carpeta.',
          '**Una sección del archivo hosts**, siempre entre `# >>> CENTRATE START` y `# <<< CENTRATE END`. El resto del archivo no lo toca.',
          '**Nada más, y nada oculto.** Lo puedes desinstalar cuando quieras.',
        ],
      },
      problems: {
        id: 'problemas',
        toc: 'Problemas frecuentes',
        headline: 'Problemas frecuentes.',
        items: [
          {
            title: '«Guardián detenido».',
            text: 'Abre Céntrate y pulsa **Reparar**. Si sigue igual, vuelve a ejecutar el instalador.',
          },
          {
            title: 'La web bloqueada sigue cargando.',
            text: 'Comprueba que la extensión está instalada y emparejada. Sin ella, los navegadores con DNS seguro o con la web ya abierta pueden tardar en respetar el bloqueo; cerrar y volver a abrir el navegador ayuda.',
          },
          {
            title: 'El Study Mode no encuentra la cámara.',
            text: 'En Windows, ve a **Configuración → Privacidad y seguridad → Cámara** y activa el acceso de las aplicaciones de escritorio. En macOS, ve a **Ajustes del Sistema → Privacidad y seguridad → Cámara** y activa Céntrate.',
          },
          {
            title: 'No veo el icono en Linux.',
            text: 'En Debian con GNOME, instala y activa la extensión AppIndicator para que Céntrate aparezca en la barra.',
          },
        ],
      },
      uninstall: {
        id: 'desinstalar',
        toc: 'Desinstalar',
        headline: 'Desinstalar Céntrate.',
        text: 'Siempre se puede, también con un bloqueo activo. Se quitan el guardián, las líneas que Céntrate añadió al archivo hosts y todo lo que instaló. Si hay un bloqueo en marcha, te avisa antes: se quitará y perderás tus puntos y tu racha.',
        items: [
          {
            label: 'Windows 11',
            text: '**Configuración → Aplicaciones → Aplicaciones instaladas**, pulsa «···» junto a Céntrate y elige **Desinstalar**.',
          },
          {
            label: 'Windows 10',
            text: '**Configuración → Aplicaciones → Aplicaciones y características**, elige Céntrate y pulsa **Desinstalar**.',
          },
          {
            label: 'macOS',
            text: 'En Céntrate, abre **Ajustes… → Sistema → Desinstalar Céntrate…** y confírmalo con tu contraseña. Así se quitan el guardián y sus líneas del archivo hosts. Después, arrastra Céntrate de Aplicaciones a la Papelera.',
          },
          {
            label: 'Linux (.deb)',
            text: 'Desde tu gestor de software o con `sudo apt remove centrate`.',
          },
          {
            label: 'Linux (AppImage)',
            text: 'En Céntrate, abre **Ajustes… → Sistema → Desinstalar Céntrate…**. Después, borra el archivo Centrate.AppImage.',
          },
          {
            label: 'Extensión',
            text: 'En la página de extensiones de tu navegador, pulsa **Quitar**. En Chrome, Edge y Brave, borra después su carpeta.',
          },
        ],
        dataNote:
          'Si también quieres borrar tus estadísticas y ajustes, antes de desinstalar usa **Ajustes… → Datos → Borrar todos mis datos**.',
      },
      requirements: {
        id: 'requisitos',
        toc: 'Requisitos',
        headline: 'Requisitos.',
        items: [
          'Windows 10 u 11 de 64\u00a0bits, macOS 12 o posterior (Apple Silicon o Intel), o Ubuntu o Debian de 64\u00a0bits.',
          'Permiso de administrador una vez, para instalar el guardián.',
          'Chrome, Edge, Brave o Firefox, para la extensión.',
          'Una webcam, solo para el Study Mode con cámara.',
          'No necesitas internet ni cuenta.',
        ],
      },
      closing: {
        releases: 'Todas las versiones en GitHub',
        changelog: { label: 'Novedades', href: '/novedades' },
        issuePrompt: '¿Algo no funciona?',
        issueLink: 'Abre una incidencia en GitHub',
      },
    },

    novedades: {
      headline: 'Novedades.',
      lead: 'Qué cambia en cada versión de Céntrate, tal y como se publica en GitHub.',
      version: 'Versión {version}',
      published: 'Publicada el {date}',
      latestPill: 'Última versión',
      viewOnGitHub: 'Ver en GitHub',
      /** Shown when GitHub already has a newer version than the one this page was built with. */
      newRelease: 'Hay una versión nueva: la {version}.',
      download: 'Descargar',
      loading: 'Cargando las novedades…',
      error: 'Ahora mismo no se pueden cargar las novedades desde GitHub.',
      errorAction: 'Ver todas las versiones en GitHub',
      empty: 'Aún no hay ninguna versión publicada. La primera está al caer.',
      cta: 'Descargar la última versión',
    },

    privacidad: {
      headline: 'Política de privacidad.',
      updated: 'Última actualización: 27 de septiembre de 2026.',
      lead: 'Céntrate funciona sin cuenta, sin internet y sin enviarnos nada. Aquí tienes qué datos se tratan, dónde se guardan y qué derechos tienes, según el Reglamento General de Protección de Datos (RGPD) y la ley española de protección de datos (LOPDGDD).',
      summary: {
        title: 'En resumen',
        items: [
          'Todo lo que usa la app se guarda en tu ordenador. No lo recibimos y no podemos verlo.',
          'La cámara se procesa al 100\u00a0% en tu ordenador: ninguna imagen se guarda, se sube ni sale del dispositivo.',
          'Sin cuenta, sin telemetría, sin anuncios y sin cookies de seguimiento.',
        ],
      },
      /** Each block is a paragraph (string) or a bullet list. Inline markup allowed. */
      sections: [
        {
          id: 'responsable',
          title: 'Quién es el responsable.',
          blocks: [
            'Céntrate es un proyecto de código abierto, con licencia MIT, publicado en GitHub por su autor, titular de la cuenta [Imdlodoem23](https://github.com/Imdlodoem23), que es quien responde de esta web y de la app.',
            'La app no nos envía tus datos: todo lo que se describe aquí lo guarda y lo trata tu propio ordenador. Para cualquier consulta, mira el apartado «Cambios y contacto».',
          ],
        },
        {
          id: 'que-guarda',
          title: 'Qué guarda la app y dónde.',
          blocks: [
            'Todo esto se guarda solo en tu ordenador:',
            {
              list: [
                'tus bloqueos, horarios, plantillas, ajustes y tu motivo;',
                'las tareas de tus sesiones de Study Mode;',
                'tus puntos, tu XP, tu racha y tus logros, y el registro de eventos del que salen: intentos, strikes, castigos, bloqueos cumplidos y desbloqueos de emergencia;',
                'tus estadísticas, como los minutos concentrado y el número de avisos;',
                'la calibración del Study Mode, que son solo números, nunca fotos;',
                'registros técnicos rotativos, sin datos personales, para diagnosticar fallos.',
              ],
            },
            'Una parte la guarda el guardián en una carpeta del sistema que solo él puede modificar, para que nadie pueda hacer trampa: `C:\\ProgramData\\Centrate\\` en Windows, `/Library/Application Support/Centrate/` en macOS y `/var/lib/centrate/` en Linux. El resto está en la carpeta de datos de la app, dentro de tu usuario.',
            '«Copiar diagnóstico», en Ajustes, solo copia esos registros técnicos a tu portapapeles: tú decides si los compartes.',
          ],
        },
        {
          id: 'camara',
          title: 'La cámara, 100\u00a0% en tu ordenador.',
          blocks: [
            {
              list: [
                'Solo se enciende cuando tú empiezas el Study Mode, después de que des tu consentimiento la primera vez. Mientras está encendida, ves siempre el aviso «Cámara activa».',
                'Analiza entre 2 y 4 imágenes por segundo, a baja resolución, con modelos de IA que van dentro de la app y funcionan sin internet.',
                'Cada imagen se descarta al momento: no se guarda, no se sube y no sale de tu ordenador. La vista previa es opcional y solo aparece en tu pantalla.',
                'No te identifica: no hay reconocimiento facial. Solo comprueba si hay alguien, hacia dónde mira, si tiene los ojos cerrados mucho rato y si aparece un móvil o un libro.',
                'La calibración y el botón «¡Estaba estudiando!» guardan números, como los ángulos de la cabeza o la probabilidad de que haya un móvil, nunca imágenes. Puedes recalibrar cuando quieras, y «Borrar todos mis datos» la elimina.',
                'Puedes usar el Study Mode sin cámara, que solo tiene en cuenta la app que tienes delante y tu actividad con el teclado y el ratón.',
              ],
            },
          ],
        },
        {
          id: 'extension',
          title: 'La extensión del navegador.',
          blocks: [
            'La extensión compara, dentro de tu navegador, cada web que abres con tu lista de bloqueos activos. Necesita permiso para todos los sitios web porque es la única forma de desviar los que bloqueas.',
            'Solo se comunica con el guardián en tu propio ordenador (`127.0.0.1`): recibe la lista de lo que está bloqueado y le avisa de los intentos. No guarda tu historial ni lo envía a ningún sitio.',
          ],
        },
        {
          id: 'internet',
          title: 'Cuándo se conecta la app a internet.',
          blocks: [
            'La app funciona sin conexión. Si hay internet, solo se conecta para:',
            {
              list: [
                'comprobar en GitHub si hay una versión nueva y, si la hay, descargarla (en macOS solo te avisa);',
                'contrastar la hora con un servidor de hora, para que adelantar el reloj del ordenador no acabe un bloqueo antes de tiempo.',
              ],
            },
            'Ninguna de las dos conexiones envía datos tuyos, aunque, como en cualquier conexión, el servidor ve tu dirección IP. No hay telemetría: la app no nos envía estadísticas de uso ni informes de errores.',
          ],
        },
        {
          id: 'web',
          title: 'Esta web.',
          blocks: [
            {
              list: [
                '**Sin cookies.** No usamos cookies ni herramientas de analítica o publicidad, así que no verás un aviso de cookies. La web puede recordar en tu navegador alguna preferencia, como si has pausado el avance de las tarjetas o el idioma que has elegido, y ese dato no sale de él.',
                '**Tipografía propia.** Las fuentes se sirven desde esta misma web, sin conectar con servicios de terceros.',
                '**Alojamiento.** La web está alojada en Render. Como cualquier servidor, registra datos técnicos de cada visita (dirección IP, fecha, página pedida y navegador) para servirla y protegerla de abusos. No los usamos para saber quién eres ni los cruzamos con nada.',
                '**GitHub.** Para enseñarte la última versión, la web puede consultar desde tu navegador la API pública de GitHub, y las descargas salen de GitHub Releases. En los dos casos, GitHub recibe tu dirección IP, como en cualquier visita a su web.',
                '**La demo.** La prueba de la página de inicio funciona en tu navegador: lo que escribes no se envía a ningún sitio.',
              ],
            },
          ],
        },
        {
          id: 'base-legal',
          title: 'Base legal.',
          blocks: [
            {
              list: [
                '**Datos de la app:** se tratan en tu ordenador y bajo tu control. Nosotros no accedemos a ellos.',
                '**Cámara:** tu consentimiento (artículo 6.1.a del RGPD), que das en la app la primera vez y puedes retirar cuando quieras dejando de usar la cámara o usando el Study Mode sin cámara.',
                '**Registros técnicos de la web:** nuestro interés legítimo en servirla y mantenerla segura (artículo 6.1.f del RGPD).',
              ],
            },
          ],
        },
        {
          id: 'plazos',
          title: 'Cuánto tiempo se guardan.',
          blocks: [
            'Los datos de la app se quedan en tu ordenador hasta que los borras con **Ajustes → Datos → Borrar todos mis datos**. Al desinstalar Céntrate se quitan el guardián y su carpeta del sistema; para borrar también tus estadísticas y ajustes, usa antes esa opción.',
            'Los registros técnicos de la web se conservan el tiempo que marque la política de Render.',
          ],
        },
        {
          id: 'terceros',
          title: 'Con quién se comparten.',
          blocks: [
            'Con nadie: no vendemos ni cedemos datos. Los únicos proveedores son Render, que aloja la web, y GitHub, que aloja el código, las descargas y las incidencias. Las dos son empresas con sede en Estados Unidos, así que esos datos técnicos pueden tratarse fuera de la Unión Europea, según sus propias políticas de privacidad.',
          ],
        },
        {
          id: 'derechos',
          title: 'Tus derechos.',
          blocks: [
            'Tienes derecho de acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad, y a retirar tu consentimiento. Como los datos de la app están en tu ordenador, los ejerces tú mismo, sin pedirnos nada:',
            {
              list: [
                '**Acceso y portabilidad:** Ajustes → Datos → **Exportar**, en CSV.',
                '**Supresión:** Ajustes → Datos → **Borrar todos mis datos**, que te pide escribir BORRAR. Los bloqueos en curso no se borran: terminan a su hora.',
                '**Rectificación:** cambia tus ajustes, horarios y plantillas cuando quieras. Los puntos no se pueden editar, para que nadie haga trampas, pero sí se pueden borrar.',
              ],
            },
            'Para cualquier otra cosa, escríbenos (apartado «Cambios y contacto»). Si crees que no hemos respetado tus derechos, puedes reclamar ante la Agencia Española de Protección de Datos ([aepd.es](https://www.aepd.es)).',
          ],
        },
        {
          id: 'menores',
          title: 'Menores.',
          blocks: [
            'Céntrate no pide cuenta ni datos personales a nadie, tampoco a menores. Si tienes menos de 14\u00a0años, lee esta política con tu madre, tu padre o tu tutor, y usa el Study Mode con cámara solo con su permiso.',
          ],
        },
        {
          id: 'seguridad',
          title: 'Seguridad.',
          blocks: [
            'Solo el guardián se ejecuta como administrador, y únicamente hace lo imprescindible: el archivo hosts, las apps de tu lista y su propia carpeta. Escucha solo en tu propio ordenador (`127.0.0.1`), exige una clave para cualquier cambio, valida todo lo que recibe y no tiene ninguna forma de terminar un bloqueo antes de tiempo.',
          ],
        },
        {
          id: 'contacto',
          title: 'Cambios y contacto.',
          blocks: [
            'Si esta política cambia, lo verás aquí con la nueva fecha y en las [novedades](/novedades). Si algún día hay funciones en línea, como cuentas o estudiar con amigos, serán opcionales y esta política se actualizará antes de que existan.',
            'Para cualquier consulta, abre una incidencia en [GitHub](https://github.com/Imdlodoem23/App-to-not-Procastinate/issues). Las incidencias son públicas: no escribas en ellas datos personales. Si necesitas tratar algo en privado, dilo en la incidencia y te indicaremos un canal privado.',
          ],
        },
      ],
    },

    notFound: {
      headline: 'Esta página no existe.',
      lead: 'No la hemos bloqueado, te lo prometemos: puede que el enlace esté mal escrito o que la página se haya movido.',
      home: { label: 'Ir al inicio', href: '/' },
      download: { label: 'Descargar Céntrate', href: '/descargar' },
    },
  },

  meta: {
    siteName: 'Céntrate',
    locale: 'es_ES',
    ogImageAlt: 'La ventana de Céntrate con YouTube bloqueado hasta las 17:42 y una cuenta atrás.',
    home: {
      title: 'Céntrate: la app gratis para dejar de procrastinar',
      ogTitle: 'Céntrate. Escríbelo. Y olvídate.',
      description:
        'Escribe «no veo YouTube en una hora» y Céntrate lo bloquea aunque cierres la app. Con Study Mode y puntos. Gratis y sin cuenta para Windows, macOS y Linux.',
    },
    descargar: {
      title: 'Descargar Céntrate para Windows, macOS y Linux',
      description:
        'Descarga Céntrate gratis. Pasos para cada sistema, la extensión del navegador, cómo pasar los avisos de seguridad, comprobar el SHA-256 y desinstalar.',
    },
    novedades: {
      title: 'Novedades · Céntrate',
      description: 'Qué cambia en cada versión de Céntrate, tal y como se publica en GitHub.',
    },
    privacidad: {
      title: 'Política de privacidad · Céntrate',
      description:
        'Qué guarda Céntrate y dónde: todo en tu ordenador, la cámara al 100\u00a0% en local y sin cuenta ni cookies de seguimiento. Adaptada al RGPD.',
    },
    notFound: {
      title: 'Página no encontrada · Céntrate',
      description: 'Esta página no existe. Vuelve al inicio o descarga Céntrate.',
    },
  },
} as const;

/** Keys that may hold identifiers shared by every language (a footnote, a window state). */
type FixedKey = 'note' | 'leadNote' | 'visual';
type FixedValue = FootnoteId | AppWindowState;

/**
 * The shape of a translation: the Spanish copy with every string widened to `string`, except
 * footnote ids and window states under `FixedKey` (`note: 'admin'`). Arrays keep their length
 * (they are tuples), so a translation has exactly the same keys, items and footnote references
 * as the Spanish original.
 */
export type Localized<T> = T extends string
  ? string
  : T extends object
    ? {
        readonly [K in keyof T]: K extends FixedKey
          ? T[K] extends FixedValue
            ? T[K]
            : Localized<T[K]>
          : Localized<T[K]>;
      }
    : T;

export type Copy = Localized<typeof es>;

/** Footnotes in display order, numbered from 1. */
export function footnoteList(copy: Copy): readonly { id: FootnoteId; n: number; text: string }[] {
  return (Object.keys(notes) as FootnoteId[]).map((id, index) => ({
    id,
    n: index + 1,
    text: copy.footnotes.items[id],
  }));
}

/** Number shown for a footnote reference (the same in every language). */
export function footnoteNumber(id: FootnoteId): number {
  return (Object.keys(notes) as FootnoteId[]).indexOf(id) + 1;
}

type Placeholders<S extends string> = S extends `${string}{${infer Key}}${infer Rest}`
  ? Key | Placeholders<Rest>
  : never;

/**
 * Fills {placeholders}. With a literal template the keys are checked at compile time; with a
 * `Copy` string (any language) they are checked against the Spanish original at build time by
 * `translationProblems()`.
 */
export function fill<S extends string>(
  template: S,
  values: string extends S
    ? Readonly<Record<string, string | number>>
    : { readonly [K in Placeholders<S>]: string | number },
): string {
  const lookup = values as Readonly<Record<string, string | number>>;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in lookup ? String(lookup[key]) : match,
  );
}

const placeholdersOf = (text: string): string =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
const linksOf = (text: string): number => [...text.matchAll(/\]\([^)\s]+\)/g)].length;

/**
 * Differences between the Spanish copy and a translation that the type cannot see: the order
 * of keys, the {placeholders} and the number of [links](…) of every string, and empty strings
 * where the original has text. Empty list when they match.
 */
export function translationProblems(source: unknown, target: unknown, path = 'copy'): string[] {
  if (typeof source === 'string') {
    if (typeof target !== 'string') return [`${path}: not a string`];
    const problems: string[] = [];
    if (placeholdersOf(source) !== placeholdersOf(target)) {
      problems.push(`${path}: placeholders differ («${source}» / «${target}»)`);
    }
    if (linksOf(source) !== linksOf(target)) problems.push(`${path}: links differ`);
    if (source !== '' && target.trim() === '') problems.push(`${path}: empty`);
    return problems;
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(target) || target.length !== source.length) {
      return [`${path}: length differs`];
    }
    return source.flatMap((item, i) => translationProblems(item, target[i], `${path}[${i}]`));
  }
  if (typeof source === 'object' && source !== null) {
    if (typeof target !== 'object' || target === null) return [`${path}: not an object`];
    const keys = Object.keys(source);
    if (keys.join() !== Object.keys(target).join()) return [`${path}: keys differ`];
    const a = source as Record<string, unknown>;
    const b = target as Record<string, unknown>;
    return keys.flatMap((key) => translationProblems(a[key], b[key], `${path}.${key}`));
  }
  return source === target ? [] : [`${path}: ${String(source)} / ${String(target)}`];
}

export type InlineToken =
  | { readonly kind: 'text' | 'strong' | 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Splits a string with **bold**, `code` and [text](href) into tokens a component can render. */
export function inline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: 'text', text: source.slice(last, index) });
    const [whole, strong, code, linkText, href] = match;
    if (strong !== undefined) tokens.push({ kind: 'strong', text: strong });
    else if (code !== undefined) tokens.push({ kind: 'code', text: code });
    else tokens.push({ kind: 'link', text: linkText ?? '', href: href ?? '' });
    last = index + whole.length;
  }
  if (last < source.length) tokens.push({ kind: 'text', text: source.slice(last) });
  return tokens;
}

/** The same string without inline markup (for meta tags, aria-labels and titles). */
export function plain(source: string): string {
  return inline(source)
    .map((token) => token.text)
    .join('');
}
