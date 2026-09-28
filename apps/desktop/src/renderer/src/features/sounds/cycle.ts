/**
 * What the concentration sounds should play (PROMPT §9 «Sonidos de concentración», §10 «"Sonido"
 * pasa por Nada, Lluvia, Ruido blanco y Lo-fi con cada clic»), pure:
 *
 * - `prefs.sounds.ambient` is the choice (`none` = silence), shared by every window through the
 *   snapshot: the Study Mode tile and Ajustes change it with `prefs:set`, the main window plays.
 * - It plays during a study session (started by hand), while any block is active when
 *   «autoplay» is on, and after the user picks a sound during this run (so choosing one is heard
 *   at once); picking «Nada» stops it. A restart never starts music by itself unless autoplay
 *   applies.
 * - Harness runs stay silent: screenshots and timings must not depend on an audio device.
 */
import {
  SOUND_IDS,
  type AmbientSound,
  type SoundId,
  type SoundPrefs,
} from '../../../../shared/prefs';
import { SOUNDS } from './i18n';

/** Nada → Lluvia → Ruido blanco → Lo-fi → Nada… */
export const SOUND_CYCLE: readonly AmbientSound[] = Object.freeze(['none', ...SOUND_IDS]);

/** The sound the next click on «Sonido» picks. */
export function nextAmbient(current: AmbientSound): AmbientSound {
  const index = SOUND_CYCLE.indexOf(current);
  return SOUND_CYCLE[(index + 1) % SOUND_CYCLE.length] ?? 'none';
}

export function ambientName(sound: AmbientSound): string {
  return SOUNDS.names[sound];
}

/** «Sonido: Lluvia». */
export function soundTileLabel(sound: AmbientSound): string {
  return SOUNDS.tile(ambientName(sound));
}

/** «Un clic pasa a Ruido blanco; suena sin internet». */
export function soundTileHelp(sound: AmbientSound): string {
  return SOUNDS.tileHelp(ambientName(nextAmbient(sound)));
}

/**
 * Whether the user's own pick is playing after the choice moved from `previous` to `next`
 * (`wasManual` before): a pick of a sound starts it, «Nada» stops it, no change keeps it.
 */
export function manualAfterChange(
  previous: AmbientSound,
  next: AmbientSound,
  wasManual: boolean,
): boolean {
  if (next === previous) return wasManual;
  return next !== 'none';
}

export interface SoundPlanInput {
  /** The `sounds` flag (hidden features never make a sound). */
  enabled: boolean;
  prefs: Pick<SoundPrefs, 'ambient' | 'autoplay'>;
  /** Any block is active now. */
  blockActive: boolean;
  /** A study session is running (not paused, not over). */
  studyActive: boolean;
  /** The user picked the current sound during this run (`manualAfterChange`). */
  manual: boolean;
  /** Harness runs never play. */
  harness: boolean;
}

/** The loop to play now, or `null` for silence. */
export function desiredSound(input: SoundPlanInput): SoundId | null {
  const { ambient, autoplay } = input.prefs;
  if (!input.enabled || input.harness || ambient === 'none') return null;
  if (input.studyActive || input.manual || (autoplay && input.blockActive)) return ambient;
  return null;
}
