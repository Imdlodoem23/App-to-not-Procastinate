/**
 * Spanish strings of section 2 «Bloqueo» (PROMPT §10 «Secciones, 2. Bloqueo», §4). Shared
 * wording (mode names, target lists, points, remaining time) comes from
 * `src/shared/i18n/es.ts` through `src/shared/format.ts`; this file only holds what the
 * section says itself. Ready for an `en.ts` with the same shape (`BloqueoMessages`).
 */
import type { CategoryId } from '@centrate/shared/catalog';
import type { BlockMode, PunishmentCause, PunishmentLevel } from '@centrate/shared/domain';

export const BLOQUEO_ES = {
  sectionName: 'Bloqueo',

  header: {
    none: 'Bloqueo: ninguno',
    finished: 'Bloqueo: terminado',
    /** «Bloqueo: YouTube, Instagram · Estricto». Every fallback keeps «Bloqueo:». */
    active: (targets: string, mode: string): string => `Bloqueo: ${targets} · ${mode}`,
    /** Fallback when not even one name fits: «Bloqueo: 3 · Estricto». */
    activeCount: (count: number, mode: string): string => `Bloqueo: ${count} · ${mode}`,
    /** Last one-line fallback, one target: «Bloqueo: Estricto». */
    activeMode: (mode: string): string => `Bloqueo: ${mode}`,
    /** Short category names for the header («Bloqueo: Redes +2 · Estricto»). */
    categoryShort: {
      social: 'Redes',
      video: 'Vídeo',
      games: 'Juegos',
      messaging: 'Mensajería',
      shopping: 'Compras',
      news: 'Noticias',
    } satisfies Record<CategoryId, string>,
    /** Short «Todo salvo la lista blanca» («Bloqueo: solo lista blanca · Examen»). */
    whitelistShort: 'solo lista blanca',
    /** «Castigo: todas las distracciones · 60 min» (always in minutes: 15 … 120). */
    punishment: (level: string, minutes: number): string => `Castigo: ${level} · ${minutes} min`,
    /** Shorter punishment title when the whole one does not fit: «Castigo: 60 min». */
    punishmentShort: (what: string): string => `Castigo: ${what}`,
    /** «Próximo horario: 18:00», «Próximo horario: mañana 16:00». */
    nextSchedule: (when: string): string => `Próximo horario: ${when}`,
    /** «Hecho. +80 puntos». */
    finishedPoints: (points: string): string => `Hecho. ${points}`,
    finishedNoPoints: 'Hecho',
    newPill: 'Nuevo',
    newPillLabel: 'Nuevo bloqueo: vuelve al campo',
  },

  field: {
    /** Accessible name of the main field. */
    label: '¿Qué quieres hacer?',
    /** Help line while the field is empty. */
    hint: '¿Qué quieres hacer? Escríbelo y pulsa Enter',
    /**
     * Placeholder examples, one every 4 s while the field is empty. Every one must be fully
     * understood by the parser (a test checks it).
     */
    examples: [
      'no veo YouTube en una hora',
      'nada de TikTok ni Instagram durante 45 minutos',
      'bloquea las redes sociales hasta las 20:30',
      'sin juegos hora y media',
      'no quiero ver Netflix 2h',
      'nada de Twitch ni Discord 30 min',
    ],
    /** «No he entendido: "mañana tarde"». */
    notUnderstood: (fragments: readonly string[]): string =>
      `No he entendido: ${fragments.map((f) => `"${f}"`).join(', ')}`,
    notUnderstoodAll: (text: string): string => `No he entendido: "${text}"`,
    /** Screen readers, once typing pauses: «Entendido: YouTube, 1 h, hasta 18:00». */
    understood: (parts: readonly string[]): string => `Entendido: ${parts.join(', ')}`,
    /** After the chips when Enter will open Bloqueos (nothing is invented). */
    missingDuration: 'falta cuánto tiempo',
    missingTargets: 'falta qué bloquear',
    chipHint: 'Corrige esta parte de la frase',
    /** «+2» chip when the chips do not fit on the help line. */
    moreChips: (count: number): string => `+${count}`,
    /** The chip standing for every target when none fits: «3 webs», «2 categorías». */
    hiddenTargets: (count: number, kind: 'web' | 'category' | 'mixed'): string =>
      kind === 'web'
        ? `${count} ${count === 1 ? 'web' : 'webs'}`
        : kind === 'category'
          ? `${count} ${count === 1 ? 'categoría' : 'categorías'}`
          : `${count} cosas`,
  },

  templates: {
    rowLabel: 'Plantillas',
    rowHelp: 'Un clic prepara el bloqueo y Enter lo confirma',
    more: 'Más…',
    moreHelp: 'Abre Bloqueos: formulario completo, plantillas y horarios',
    /** «Redes sociales, Vídeo y streaming +2 · 1 h · Normal». */
    help: (targets: string, duration: string, mode: string): string =>
      `${targets} · ${duration} · ${mode}`,
    modeFromSettings: (mode: string): string => `${mode} (por defecto)`,
  },

  card: {
    label: 'Confirmar el bloqueo',
    targetsLabel: 'Qué se bloquea',
    durationChip: 'Duración',
    endChip: 'Hora de fin',
    editTargetsPlaceholder: 'YouTube, redes, marca.com…',
    editDurationPlaceholder: '45 min, 2 h, 1h30…',
    editEndPlaceholder: '18:30, mañana a las 8…',
    editHelp: 'Enter aplica · Esc deja como estaba',
    modesLabel: 'Modo',
    modeHelp: {
      normal: 'Normal: la emergencia tarda 10 min y cuesta al menos 200 puntos',
      strict: 'Estricto: la emergencia tarda 30 min y cuesta al menos 200 puntos',
      hardcore: 'Hardcore: no se puede cancelar de ninguna forma',
      exam: 'Examen: solo webs y apps de estudio, y no se puede cancelar',
    } satisfies Record<BlockMode, string>,
    reasonLabel: 'Tu motivo',
    reasonPlaceholder: 'Tu motivo (opcional): «Quiero aprobar mates»',
    reminder: 'Solo se puede ampliar, nunca acortar',
    edit: 'Editar…',
    editHelp2: 'Abre Bloqueos con este bloqueo para cambiar más cosas',
    /** «Bloquear hasta 17:42». `until` comes from the parser's `untilLabel`. */
    confirm: (until: string): string => `Bloquear ${until}`,
    /** «Sí, bloquear 6 h». */
    confirmAgain: (duration: string): string => `Sí, bloquear ${duration}`,
    /** The confirm button's help is the brief's reminder (it keeps focus most of the time). */
    confirmHelp: 'Solo se puede ampliar, nunca acortar',
    confirmAgainHelp: 'Pulsa otra vez para bloquear',
    pending: 'Bloqueando…',
    pendingHelp: 'Esperando al guardián',
    /**
     * Screen readers: what the confirm button commits («Bloquea YouTube e Instagram durante
     * 1 hora, hasta las 18:00, modo Estricto»). `until` comes from `untilPhrase`.
     */
    summary: (targets: string, duration: string, until: string, mode: string): string =>
      `Bloquea ${targets} durante ${duration}, ${until}, modo ${mode}`,
    /** «Todo salvo la lista blanca» inside the sentence. */
    summaryWhitelist: 'todo salvo la lista blanca',
    summaryNoTargets: (duration: string, until: string, mode: string): string =>
      `Nada elegido para bloquear. ${duration}, ${until}, modo ${mode}`,
    /** «1 hora y 30 minutos», «45 minutos» (spoken, never «1 h»). */
    durationWords: (hours: number, minutes: number): string => {
      const parts: string[] = [];
      if (hours > 0) parts.push(hours === 1 ? '1 hora' : `${hours} horas`);
      if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minuto' : `${minutes} minutos`);
      return parts.join(' y ');
    },
    /** «6 h: termina a las 23:42 y solo se puede ampliar». */
    consequenceLong: (duration: string, ends: string): string =>
      `${duration}: termina ${ends} y solo se puede ampliar`,
    /** «No podrás cancelarlo de ninguna forma hasta las 20:42». */
    consequenceNoEmergency: (until: string): string =>
      `No podrás cancelarlo de ninguna forma ${until}`,
    problem: {
      no_targets: 'Elige qué bloquear: pulsa una ficha o Editar…',
      too_short: 'Como mínimo 5 min',
      too_long: 'Como mucho 24 h',
    },
    retry: 'Reintentar',
    retryHelp: 'Reenvía el mismo bloqueo: nunca se duplica',
    repair: 'Reparar',
    repairHelp: 'Arranca el guardián (pide permiso de administrador)',
    repairStarted: 'Guardián arrancado: pulsa Reintentar',
    repairCancelled: 'No se ha dado el permiso',
    repairUnsupported: 'No se puede reparar desde aquí: mira Ajustes',
  },

  active: {
    extendLabel: 'Ampliar',
    /** Tile labels. */
    plus: (duration: string): string => `+${duration}`,
    other: 'Otro…',
    extendHelp: 'Solo se puede ampliar, nunca acortar',
    /** «+15 min: termina a las 17:57». */
    extendTileHelp: (plus: string, ends: string): string => `${plus}: termina ${ends}`,
    otherHelp: 'Amplía lo que tú digas',
    maxReached: 'Como mucho 24 h en total',
    /** «+30 min · termina a las 18:12 · ». */
    undoLine: (plus: string, ends: string): string => `${plus} · termina ${ends}`,
    /** «Deshacer (4 s)». */
    undo: (seconds: number): string => `Deshacer (${seconds} s)`,
    undoLabel: (plus: string): string => `Deshacer la ampliación de ${plus}`,
    sending: (plus: string): string => `${plus} · ampliando…`,
    failed: 'No se pudo ampliar',
    tooLate: 'Ya ampliado',
    /** After «Deshacer»: the line says it for a moment (and screen readers hear it). */
    undone: 'Ampliación deshecha',
    /** Spoken once when the undo line appears (the ticking seconds are never spoken). */
    undoAnnounce: (plus: string, ends: string, seconds: number): string =>
      `${plus}, termina ${ends}. Puedes deshacerlo durante ${seconds} segundos`,
    failedAnnounce: 'No se pudo ampliar: puedes reintentarlo',
    otherPlaceholder: '¿Cuánto más? 20 min, 1 h…',
    otherLabel: 'Cuánto quieres ampliar',
    otherApply: 'Ampliar',
    otherInvalid: 'Escribe cuánto: 20 min, 1 h, 1h30…',
    /** «Como mucho +1 h 5 min más». */
    otherTooMuch: (max: string): string => `Como mucho ${max} más`,
    otherHelpLabel: 'Enter amplía · Esc cancela',
    /** Secondary block row: «Juegos · Hardcore». */
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    /** «y 3 más…». */
    more: (count: number): string => `y ${count} más…`,
    moreHelp: 'Abre Bloqueos con todos los bloqueos activos',
    emergency: 'Desbloqueo de emergencia…',
    emergencyHelp: 'Cancela el bloqueo con espera y pierdes puntos',
    noEmergency: {
      hardcore: 'Hardcore: no se puede cancelar',
      exam: 'Examen: no se puede cancelar',
    },
    /** «Emergencia: 8:12». */
    emergencyCounting: (countdown: string): string => `Emergencia: ${countdown}`,
    emergencyReady: 'Emergencia: lista',
    bootHold: 'Comprobando la hora…',
    reasonLabel: 'Tu motivo',
  },

  punishment: {
    level: {
      distractions: 'todas las distracciones',
      whitelist: 'solo lista blanca',
      nuclear: 'ordenador bloqueado',
    } satisfies Record<PunishmentLevel, string>,
    /** «3 strikes en "mates"». */
    cause: (cause: PunishmentCause, task: string): string => {
      if (cause === 'three_strikes') return task ? `3 strikes en "${task}"` : '3 strikes';
      return task ? `Study Mode abandonado: "${task}"` : 'Study Mode abandonado';
    },
  },

  study: {
    /** Reason seeded from a study phrase when its own words cannot be reused. */
    reason: (task: string): string => `Estudiar ${task}`,
  },

  /** «18:00», «mañana 16:00», «jue 16:00» (next schedule). */
  when: {
    tomorrow: (time: string): string => `mañana ${time}`,
    weekday: (day: string, time: string): string => `${day} ${time}`,
  },
  /** «a las 23:42», «mañana a las 08:00», «el jue a las 08:00» (consequence and undo lines). */
  ends: {
    today: (time: string): string => `a las ${time}`,
    tomorrow: (time: string): string => `mañana a las ${time}`,
    weekday: (day: string, time: string): string => `el ${day} a las ${time}`,
  },
  /** «hasta las 20:42», «hasta mañana a las 08:00». */
  untilLong: {
    today: (time: string): string => `hasta las ${time}`,
    tomorrow: (time: string): string => `hasta mañana a las ${time}`,
    weekday: (day: string, time: string): string => `hasta el ${day} a las ${time}`,
  },
} as const;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { [K in keyof T]: Widen<T[K]> };

/** Shape every language file of the section must match. */
export type BloqueoMessages = Widen<typeof BLOQUEO_ES>;
