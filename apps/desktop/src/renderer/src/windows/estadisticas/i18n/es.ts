/**
 * Spanish strings of the Estadísticas window (PROMPT §9 «Estadísticas», §10 «Ventanas de
 * detalle › Estadísticas»). Numbers, durations, clock times and dates arrive formatted; the
 * functions only put them in order. Points lost are a fact, never a reproach. `en.ts` has the
 * same shape (`EstadisticasMessages`).
 */
import type { EventType } from '@centrate/shared/domain';
import type { Widen } from '../../../../../shared/i18n/locale';
import type { EventLogFilter, StatsRange } from '../../../../../shared/stats';

type EventLabels = Record<EventType, string>;

const EVENT_LABELS: EventLabels = {
  guardian_started: 'Guardián iniciado',
  epoch_started: 'Registro nuevo',
  clock_jump: 'Cambio de hora detectado',
  day_closed: 'Día cerrado',
  block_created: 'Bloqueo',
  block_extended: 'Ampliado',
  block_completed: 'Bloqueo cumplido',
  block_cancelled: 'Bloqueo cancelado',
  block_reactivated: 'Bloqueo reactivado',
  attempt: 'Intento',
  process_closed: 'App cerrada',
  study_started: 'Study Mode',
  study_paused: 'Study Mode en pausa',
  study_resumed: 'Study Mode reanudado',
  focus_minutes: 'Concentrado',
  strike: 'Strike',
  study_ended: 'Study Mode terminado',
  study_outcome: 'Resultado de la sesión',
  punishment_started: 'Castigo',
  punishment_ended: 'Castigo terminado',
  emergency_requested: 'Emergencia pedida',
  emergency_cancelled: 'Emergencia cancelada',
  emergency_confirmed: 'Desbloqueo de emergencia',
  reward_redeemed: 'Recompensa',
  reward_ended: 'Recompensa terminada',
  schedule_created: 'Horario nuevo',
  schedule_updated: 'Horario cambiado',
  schedule_deleted: 'Horario borrado',
  settings_changed: 'Ajustes cambiados',
  extension_paired: 'Extensión emparejada',
  extension_revoked: 'Extensión quitada',
  tamper_detected: 'Manipulación detectada',
  ledger_repaired: 'Registro reparado',
};

export const ESTADISTICAS_ES = {
  /** The chart section: «Concentrado: 14 h». */
  title: (duration: string): string => `Concentrado: ${duration}`,
  loading: 'Leyendo tus estadísticas…',

  ranges: {
    rowLabel: 'Periodo',
    day: 'Día',
    week: 'Semana',
    month: 'Mes',
    help: {
      day: 'Tu tiempo concentrado hora a hora',
      week: 'Tu tiempo concentrado de lunes a domingo',
      month: 'Tu tiempo concentrado cada día del mes',
    } satisfies Record<StatsRange, string>,
  },

  nav: {
    rowLabel: 'Cambiar de periodo',
    previous: {
      day: '‹ Día anterior',
      week: '‹ Semana anterior',
      month: '‹ Mes anterior',
    } satisfies Record<StatsRange, string>,
    current: {
      day: 'Hoy',
      week: 'Esta semana',
      month: 'Este mes',
    } satisfies Record<StatsRange, string>,
    next: {
      day: 'Día siguiente ›',
      week: 'Semana siguiente ›',
      month: 'Mes siguiente ›',
    } satisfies Record<StatsRange, string>,
    previousHelp: 'Ver el periodo anterior',
    currentHelp: 'Volver al periodo de hoy',
    nextHelp: 'Ver el periodo siguiente',
    atCurrent: 'Ya estás viendo el periodo de hoy',
    future: 'Lo que aún no ha pasado no tiene estadísticas',
  },

  /** Header datum and dates («hoy», «jue 24 sept», «21–27 sept», «septiembre de 2026»). */
  dates: {
    today: 'hoy',
    yesterday: 'ayer',
    /** «jue 24 sept». */
    dayShort: (weekday: string, day: number, month: string): string => `${weekday} ${day} ${month}`,
    /** «Jueves 24 de septiembre» (starts a sentence). */
    dayLong: (weekday: string, day: number, month: string): string =>
      `${capitalize(weekday)} ${day} de ${month}`,
    /** «21–27 sept». */
    weekSameMonth: (from: number, to: number, month: string): string => `${from}–${to} ${month}`,
    /** «28 sept – 4 oct». */
    weekTwoMonths: (from: number, fromMonth: string, to: number, toMonth: string): string =>
      `${from} ${fromMonth} – ${to} ${toMonth}`,
    /** «21–27 sept 2025» when the period is not in the current year. */
    withYear: (text: string, year: number): string => `${text} ${year}`,
    /** X axis of a week: «lun 21». */
    weekTick: (weekday: string, day: number): string => `${weekday} ${day}`,
    /** Readout of a bar of a week or a month: «Jueves 24». */
    barDay: (weekday: string, day: number): string => `${capitalize(weekday)} ${day}`,
    /** «17:00–18:00». */
    hourRange: (from: string, to: string): string => `${from}–${to}`,
    /** Event log times. */
    logToday: (time: string): string => `hoy ${time}`,
    logYesterday: (time: string): string => `ayer ${time}`,
    logOlder: (day: number, month: string, time: string): string => `${day} ${month} ${time}`,
  },

  chart: {
    caption: {
      day: 'Minutos concentrado por hora',
      week: 'Minutos concentrado por día',
      month: 'Minutos concentrado por día',
    } satisfies Record<StatsRange, string>,
    /** Help line while a bar is hovered or focused: «Jueves 24: 2 h 45 min · 3 intentos». */
    readout: (when: string, duration: string, attempts: number): string =>
      attempts > 0
        ? `${when}: ${duration} · ${attempts === 1 ? '1 intento' : `${attempts} intentos`}`
        : `${when}: ${duration}`,
    /** Resting help line under the chart. */
    hint: 'Pasa el ratón por una barra, o usa las flechas, para ver sus minutos',
    /** Help line when the chart could not be drawn (its chunk or Recharts failed). */
    unavailable: 'No se ha podido dibujar el gráfico; el resumen de al lado tiene las cifras',
    /** What screen readers call the focusable chart (instead of «imagen» or «aplicación»). */
    roleDescription: 'gráfico de barras',
    none: 'Sin tiempo concentrado en este periodo',
    /** Screen-reader table beside the chart. */
    table: {
      when: { day: 'Hora', week: 'Día', month: 'Día' } satisfies Record<StatsRange, string>,
      minutes: 'Concentrado',
      attempts: 'Intentos',
      points: 'Puntos',
    },
  },

  /** The text summary beside the chart. */
  summary: {
    label: 'Resumen del periodo',
    average: 'Media al día',
    bestDay: 'Mejor día',
    bestHour: 'Mejor hora',
    /** «jue 24 · 3 h 20 min». */
    best: (when: string, duration: string): string => `${when} · ${duration}`,
    noBest: 'ninguno todavía',
    goal: 'Objetivo cumplido',
    goalToday: 'Objetivo de hoy',
    goalDay: 'Objetivo del día',
    /** «5 de 7 días». */
    goalDays: (met: number, days: number): string =>
      `${met} de ${days} ${days === 1 ? 'día' : 'días'}`,
    /** «42 de 60 min». */
    goalProgress: (done: string, goal: string): string => `${done} de ${goal}`,
    goalMet: 'cumplido',
    study: 'En Study Mode',
    blocks: 'Bloqueos cumplidos',
    attempts: 'Intentos',
    points: 'Puntos',
  },

  heatmap: {
    /** «Racha: 5 días». */
    title: (days: number): string => `Racha: ${days} ${days === 1 ? 'día' : 'días'}`,
    /** «récord: 12 días». */
    best: (days: number): string => `récord: ${days} ${days === 1 ? 'día' : 'días'}`,
    /** «Último año: 321 días con actividad · 313 con el objetivo». */
    summary: (active: number, goal: number): string =>
      `Último año: ${active} ${active === 1 ? 'día' : 'días'} con actividad · ${goal} con el objetivo`,
    /** «Sábado 26 de septiembre: 2 h 40 min · objetivo cumplido». */
    readout: (day: string, duration: string, goalMet: boolean): string =>
      goalMet ? `${day}: ${duration} · objetivo cumplido` : `${day}: ${duration}`,
    readoutNone: (day: string): string => `${day}: sin tiempo concentrado`,
    less: 'Menos',
    more: 'Más',
    /** Rows labelled on the left (Monday, Wednesday, Friday). */
    weekdays: ['L', 'X', 'V'],
  },

  targets: {
    title: 'Lo que más intentas abrir',
    listLabel: 'Lo que más intentas abrir, con sus intentos',
    /** «5 intentos · −75 puntos». */
    attempts: (n: number): string => (n === 1 ? '1 intento' : `${n} intentos`),
    none: 'Ningún intento en este periodo',
  },

  hours: {
    title: 'Tus mejores horas',
    listLabel: 'Tus mejores horas, con sus minutos',
    none: 'Aún no hay minutos en este periodo',
  },

  log: {
    /** «Registro: 12 eventos». */
    title: (n: string, count: number): string =>
      `Registro: ${n} ${count === 1 ? 'evento' : 'eventos'}`,
    titleLoading: 'Registro',
    listLabel: 'Registro de eventos, lo más nuevo primero',
    filters: {
      rowLabel: 'Filtrar el registro',
      all: 'Todo',
      blocks: 'Bloqueos',
      attempts: 'Intentos',
      points: 'Puntos',
      study: 'Study Mode',
      help: {
        all: 'Todo lo que ha pasado, lo más nuevo primero',
        blocks: 'Bloqueos creados, ampliados y cumplidos',
        attempts: 'Cada vez que intentaste abrir algo bloqueado',
        points: 'Solo lo que sumó o restó puntos',
        study: 'Sesiones, minutos concentrado y strikes',
      } satisfies Record<EventLogFilter, string>,
    },
    events: EVENT_LABELS,
    unknownEvent: 'Otro evento',
    none: 'Nada en el registro con este filtro',
    more: 'Mostrar más',
    moreHelp: (shown: string, total: string): string => `Ves ${shown} de ${total} eventos`,
    loadingMore: 'Cargando…',
  },

  exports: {
    rowLabel: 'Exportar CSV',
    events: 'Exportar eventos',
    days: 'Exportar días',
    eventsHelp: 'Un archivo CSV con cada evento: fecha, tipo, objetivo y puntos',
    daysHelp: 'Un archivo CSV con una fila por día: minutos, intentos y puntos',
    help: 'Guarda tus datos en CSV para abrirlos en una hoja de cálculo',
    saving: 'Guardando…',
    /** «Guardado: centrate-eventos-2026-09-28.csv · 12 filas». */
    saved: (file: string, rows: string, count: number): string =>
      `Guardado: ${file} · ${rows} ${count === 1 ? 'fila' : 'filas'}`,
    cancelled: 'No se ha guardado nada',
    failed: 'No he podido guardar el archivo. Prueba otra vez',
  },

  empty: {
    text: 'Tus estadísticas aparecerán después de tu primera sesión',
    action: 'Empezar 25 min',
    help: 'Abre la confirmación de un bloqueo de 25 min en la ventana principal',
  },

  /**
   * Alt + letter of every tile (PROMPT §10 «Alt + letra en cada tile»), taken from the label so
   * it is underlined while Alt is held; unique among the tiles shown together.
   */
  keys: {
    ranges: { day: 'd', week: 's', month: 'm' } satisfies Record<StatsRange, string>,
    previous: 'a',
    current: { day: 'h', week: 'e', month: 'e' } satisfies Record<StatsRange, string>,
    next: 'g',
    filters: {
      all: 't',
      blocks: 'b',
      attempts: 'n',
      points: 'p',
      study: 'y',
    } satisfies Record<EventLogFilter, string>,
    exportEvents: 'x',
    exportDays: 'r',
    more: 'o',
    empty: 'z',
    retry: 'i',
  },

  error: {
    text: 'No he podido leer tus estadísticas',
    retry: 'Reintentar',
    retryHelp: 'Vuelve a leer el registro de este ordenador',
  },
};

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('es-ES') + text.slice(1);
}

export type EstadisticasMessages = Widen<typeof ESTADISTICAS_ES>;
