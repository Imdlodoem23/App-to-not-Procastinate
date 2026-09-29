/**
 * «Plan de estudio para un examen» (owner: COACH). docs/API.md §10.1.
 *
 * The server hands the model the exact list of study days, then keeps only those days, drops
 * repeats and scales every day down to the minutes the user has.
 */
import type { StudyPlanDay, StudyPlanRequest, StudyPlanResponse } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, addDays, daysBetween } from '@centrate/shared/cloud-api';
import type { IsoWeekday, LocalDay } from '@centrate/shared/domain';
import type { StudyPlanOutput } from './schemas';
import { outputText, userData } from './text';

const L = CLOUD_LIMITS;
const ITEMS_PER_DAY_MAX = 6;
const ITEM_MIN_MINUTES = 5;
const ADVICE_MAX = 5;
const ADVICE_TEXT_MAX = 200;
/** An exam further away than this is refused (400). */
export const STUDY_EXAM_MAX_DAYS_AHEAD = 366;
/**
 * Calendar days one plan covers: `CLOUD_LIMITS.studyPlanMaxDays` (28), shared with the app. At
 * low effort the answer fits in the endpoint's `max_tokens` and deadline. A later exam gets a
 * plan for the first four weeks (`truncated`, `coversUntil`); the app asks again later.
 */
const PLAN_DAYS = L.studyPlanMaxDays;

const WEEKDAYS_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const LEVELS_ES = {
  starting: 'empieza de cero',
  intermediate: 'nivel intermedio',
  reviewing: 'ya lo ha estudiado y quiere repasar',
} as const;

/** ISO weekday of a civil date: Monday 1 … Sunday 7. */
export function isoWeekday(day: LocalDay): IsoWeekday {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return (((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1) as IsoWeekday;
}

export const weekdayName = (day: LocalDay): string => WEEKDAYS_ES[isoWeekday(day) - 1] ?? '';

/** The calendar window one plan covers and the study days in it. */
export interface StudyWindow {
  /** Study days, ascending: the window minus the days off. */
  days: LocalDay[];
  /** Last calendar day of the window (`StudyPlanResponse.coversUntil`). */
  coversUntil: LocalDay;
  /** The window stops before the day before the exam (`StudyPlanResponse.truncated`). */
  truncated: boolean;
}

/**
 * Study days: from today to the day before the exam (at most `studyPlanMaxDays` calendar
 * days), minus days off. Needs an exam at least one day after `today` (checked by the route).
 */
export function studyDays(
  body: Pick<StudyPlanRequest, 'today' | 'examDate' | 'daysOff'>,
): StudyWindow {
  const span = daysBetween(body.today, body.examDate);
  const count = Math.min(span, PLAN_DAYS);
  const off = new Set<number>(body.daysOff);
  const days: LocalDay[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = addDays(body.today, i);
    if (!off.has(isoWeekday(day))) days.push(day);
  }
  const coversUntil = addDays(body.today, Math.max(0, count - 1));
  return { days, coversUntil, truncated: span > PLAN_DAYS };
}

export function studyPlanUserMessage(
  body: StudyPlanRequest,
  days: readonly LocalDay[],
  truncated: boolean,
): string {
  const fields: Array<[string, string]> = [['asignatura', body.subject]];
  for (const topic of body.topics) fields.push(['tema', topic]);
  const lines = [
    userData(fields),
    `Nivel: ${body.level ? LEVELS_ES[body.level] : 'no indicado'}.`,
    `Examen: ${body.examDate} (${weekdayName(body.examDate)}).`,
    `Minutos de estudio por día como máximo: ${body.dailyMinutes}.`,
    `Días disponibles (${days.length}): ${days.map((d) => `${d} (${weekdayName(d)})`).join(', ')}.`,
  ];
  if (body.topics.length === 0) lines.push('No ha indicado temas.');
  if (truncated) {
    lines.push(
      `El examen es dentro de más de ${PLAN_DAYS} días: planifica solo estos días y deja el repaso final para un plan posterior.`,
    );
  }
  return lines.join('\n');
}

/** Keeps the day's items within `dailyMinutes`: scales them down, then drops the last ones. */
function fitDay(items: StudyPlanDay['items'], dailyMinutes: number): StudyPlanDay['items'] {
  const total = items.reduce((sum, i) => sum + i.minutes, 0);
  let fitted = items;
  if (total > dailyMinutes) {
    const factor = dailyMinutes / total;
    fitted = items.map((i) => ({
      ...i,
      minutes: Math.max(ITEM_MIN_MINUTES, Math.floor(i.minutes * factor)),
    }));
  }
  while (fitted.length > 0 && fitted.reduce((sum, i) => sum + i.minutes, 0) > dailyMinutes) {
    fitted = fitted.slice(0, -1);
  }
  return fitted;
}

export function studyPlanAnswer(
  output: StudyPlanOutput,
  body: StudyPlanRequest,
  planWindow: StudyWindow,
): StudyPlanResponse | null {
  const open = new Set(planWindow.days);
  const days: StudyPlanDay[] = [];
  for (const d of output.days) {
    if (!open.has(d.day)) continue;
    open.delete(d.day);
    const items = d.items
      .map((i) => ({
        topic: outputText(i.topic, L.studyTopicMax),
        kind: i.kind,
        minutes: Math.max(ITEM_MIN_MINUTES, Math.round(i.minutes)),
      }))
      .filter((i) => i.topic.length > 0)
      .slice(0, ITEMS_PER_DAY_MAX);
    const fitted = fitDay(items, body.dailyMinutes);
    if (fitted.length > 0) days.push({ day: d.day, items: fitted });
  }
  if (days.length === 0) return null;
  days.sort((a, b) => (a.day < b.day ? -1 : 1));
  const advice = output.advice
    .map((a) => outputText(a, ADVICE_TEXT_MAX))
    .filter((a) => a.length > 0)
    .slice(0, ADVICE_MAX);
  return { days, advice, coversUntil: planWindow.coversUntil, truncated: planWindow.truncated };
}
