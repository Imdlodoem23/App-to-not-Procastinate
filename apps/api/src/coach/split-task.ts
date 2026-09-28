/**
 * «Divide la tarea en pasos» (owner: COACH). docs/API.md §10.1.
 */
import type { SplitTaskRequest, SplitTaskResponse } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { parseIntent } from '@centrate/shared/parser';
import type { SplitTaskOutput } from './schemas';
import { outputText, userData } from './text';

const L = CLOUD_LIMITS;
const TITLE_MAX = 80;
const TIP_MAX = 200;
const PHRASE_MAX = 120;

export function splitTaskUserMessage(body: SplitTaskRequest): string {
  const fields: Array<[string, string]> = [['tarea', body.task]];
  if (body.context) fields.push(['contexto', body.context]);
  return [
    userData(fields),
    body.minutesAvailable === null
      ? 'Tiempo disponible: no indicado.'
      : `Tiempo disponible: ${body.minutesAvailable} minutos.`,
  ].join('\n');
}

/**
 * A step's one-tap phrase survives only if the local parser reads it completely as a study
 * session (or a block) of exactly the step's minutes, without domains the model made up.
 */
export function checkedPhrase(phrase: string | null, minutes: number, now: Date): string | null {
  if (!phrase) return null;
  const text = outputText(phrase, PHRASE_MAX);
  if (!text || text.endsWith('…')) return null;
  const r = parseIntent(text, { now });
  if (!r.complete || r.kind === 'unknown' || r.unparsed.length > 0) return null;
  if (r.domains.length > 0 || r.durationMinutes !== minutes) return null;
  return text;
}

/** Clamps the model's steps to the contract: 2–12 steps, 5–120 min, short texts. */
export function splitTaskAnswer(output: SplitTaskOutput, now: Date): SplitTaskResponse | null {
  const steps = output.steps
    .map((step) => {
      const minutes = Math.min(
        L.coachStepMaxMinutes,
        Math.max(L.coachStepMinMinutes, Math.round(step.minutes)),
      );
      return {
        title: outputText(step.title, TITLE_MAX),
        minutes,
        suggestedPhrase: checkedPhrase(step.suggestedPhrase, minutes, now),
      };
    })
    .filter((step) => step.title.length > 0)
    .slice(0, L.coachStepsMax);
  if (steps.length < L.coachStepsMin) return null;
  return { steps, firstStepTip: outputText(output.firstStepTip, TIP_MAX) };
}
