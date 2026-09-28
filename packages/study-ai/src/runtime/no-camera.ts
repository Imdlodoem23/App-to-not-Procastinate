/**
 * No-camera mode (owner: RUNTIME): foreground app/web + keyboard/mouse activity only, ticked
 * at 1 Hz. No absence path; strike causes are `distraction_app` or `doubt_timeout`.
 * DESIGN.md §8.4.
 */
import type { Observation, Observer, StudyAiSettings, StudyMode, TickInput } from '../types';
import { notImplemented } from '../util/not-implemented';

export class NoCameraObserver implements Observer {
  readonly mode: StudyMode = 'no-camera';

  observe(_input: TickInput, _settings: Readonly<StudyAiSettings>): Observation {
    return notImplemented('NoCameraObserver.observe');
  }

  rescore(_observation: Observation, _settings: Readonly<StudyAiSettings>): number | null {
    return notImplemented('NoCameraObserver.rescore');
  }

  reset(): void {
    notImplemented('NoCameraObserver.reset');
  }
}
