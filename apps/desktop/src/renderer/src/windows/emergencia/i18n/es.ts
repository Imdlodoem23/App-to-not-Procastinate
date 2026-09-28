/**
 * Spanish strings of the Emergencia window (PROMPT §7 «Desbloqueo de emergencia», §10
 * «Ventanas de detalle › Emergencia»). Penalties are a fact, never a reproach; the way back is
 * always the recommended one. Points and clock times are formatted before they get here.
 * `en.ts` has the same shape (`EmergenciaMessages`).
 */
import type { BlockMode } from '@centrate/shared/domain';
import type { Widen } from '../../../../../shared/i18n/locale';

export const EMERGENCIA_ES = {
  title: {
    /** «Emergencia: YouTube». */
    request: (what: string): string => `Emergencia: ${what}`,
    unavailable: 'Emergencia: no disponible',
    counting: 'Emergencia: esperando',
    ready: 'Emergencia: lista',
    done: 'Emergencia: desbloqueado',
  },
  /** Header datum while counting: «lista a las 17:08». */
  readyAt: (time: string): string => `lista a las ${time}`,
  /** Header datum once ready: «hasta las 17:13» (the confirm deadline). */
  deadline: (time: string): string => `hasta las ${time}`,
  /** «espera de 10 min». */
  wait: (minutes: number): string => `espera de ${minutes} min`,
  /** «2 bloqueos» when the unlock covers several. */
  blocks: (n: number): string => (n === 1 ? '1 bloqueo' : `${n} bloqueos`),
  /** «Perderás 620 puntos y tu racha de 5 días». `points` is formatted («620 puntos»). */
  loss: (points: string, streakDays: number): string =>
    streakDays > 0
      ? `Perderás ${points} y tu racha de ${streakDays} ${streakDays === 1 ? 'día' : 'días'}`
      : `Perderás ${points}`,
  /** Short loss for the header datum: «−620 puntos». */
  lossShort: (signedPoints: string): string => signedPoints,
  listLabel: 'Bloqueos afectados',
  /** «YouTube · Normal». */
  row: (targets: string, mode: string): string => `${targets} · ${mode}`,
  cancels: 'se cancela',
  stays: 'sigue activo',

  phrase: {
    intro: 'Escribe a mano esta frase:',
    label: 'Frase de compromiso',
    empty: 'Escríbela tú: pegar no vale',
    typing: 'Sigue escribiendo…',
    mismatch: 'No coincide: revisa lo que has escrito',
    ok: 'Coincide',
    pasted: 'Escríbela a mano: pegar no vale',
  },

  actions: {
    rowLabel: 'Qué hacer',
    /** «Empezar la espera de 10 min». */
    request: (minutes: number): string => `Empezar la espera de ${minutes} min`,
    requestHelp: 'El bloqueo sigue mientras esperas, y puedes cancelarla gratis',
    requestDisabled: 'Primero escribe la frase exacta',
    requesting: 'Pidiendo…',
    stay: 'Seguir bloqueado',
    stayHelp: 'Cierra esta ventana sin perder nada',
    cancel: 'Cancelar (recomendado)',
    cancelHelp: 'No pierdes nada y el bloqueo sigue',
    unlock: 'Desbloquear',
    unlockHelp: 'Pide confirmación antes de cobrar nada',
    close: 'Cerrar',
    closeHelp: 'Cierra esta ventana',
  },

  waiting: 'Esperando',
  waitingHelp: 'Cuando acabe tendrás 5 min para desbloquear; si no, el bloqueo sigue',
  /** Screen readers, as the wait crosses 15, 5 and 1 min (the window says when it is ready). */
  waitMark: (minutes: number): string =>
    minutes === 1 ? 'Podrás desbloquear en 1 minuto' : `Podrás desbloquear en ${minutes} minutos`,
  waitEnd: 'Ya puedes desbloquear',
  /** Screen readers, while the time to confirm runs out. */
  decideMark: (minutes: number): string =>
    minutes === 1 ? 'Queda 1 minuto para decidir' : `Quedan ${minutes} minutos para decidir`,
  decideEnd: 'Se acabó el tiempo: el bloqueo sigue',
  /** «Tienes 4:30 para decidir» (the countdown is its own element). */
  readyLead: 'Tienes',
  readyTail: 'para decidir; después, el bloqueo sigue',
  cancelled: 'Cancelada: no has perdido nada',

  /** What the window's polite region says (never the same words as a visible line). */
  announce: {
    /** «Emergencia: esperando, lista a las 17:08». */
    stage: (title: string, datum: string | null): string => (datum ? `${title}, ${datum}` : title),
    phraseOk: 'Frase correcta: ya puedes empezar la espera',
    phraseMismatch: 'La frase tiene un error: revísala',
    pasted: 'Pegar no está permitido: tienes que teclear la frase',
  },

  done: {
    /** «Se ha cancelado 1 bloqueo». */
    cancelled: (n: number): string =>
      n === 1 ? 'Se ha cancelado 1 bloqueo' : `Se han cancelado ${n} bloqueos`,
    /** «Has perdido 620 puntos y tu racha de 5 días». */
    lost: (points: string, streakDays: number): string =>
      streakDays > 0
        ? `Has perdido ${points} y tu racha de ${streakDays} ${streakDays === 1 ? 'día' : 'días'}`
        : `Has perdido ${points}`,
    /** «Saldo: 620 puntos». */
    balance: (points: string): string => `Saldo: ${points}`,
  },

  unavailable: {
    /** «Hardcore: no se puede cancelar de ninguna forma hasta las 18:42». */
    noEmergency: (mode: string, until: string): string =>
      `${mode}: no se puede cancelar de ninguna forma ${until}`,
    none: 'No hay ningún bloqueo que se pueda cancelar',
    help: 'Nadie puede acortarlo, tampoco desde aquí',
  },

  /** «hasta las 18:42», «hasta mañana a las 08:00». */
  until: {
    today: (time: string): string => `hasta las ${time}`,
    tomorrow: (time: string): string => `hasta mañana a las ${time}`,
    later: (date: string, time: string): string => `hasta el ${date} a las ${time}`,
  },

  modes: {
    hardcore: 'Hardcore',
    exam: 'Examen',
  } satisfies Partial<Record<BlockMode, string>>,
} as const;

/** Shape every language file of the window must match. */
export type EmergenciaMessages = Widen<typeof EMERGENCIA_ES>;
