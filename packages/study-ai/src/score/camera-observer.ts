/**
 * Camera ticks → observations (owner: DECISION): presence, evidence persistence, fusion of
 * the classifier with the rules, drowsiness candidates and the stale-profile check.
 * DESIGN.md §7.1–7.4.
 */
import type {
  AttentionClassifier,
  Observation,
  Observer,
  StudyAiSettings,
  StudyMode,
  TickInput,
} from '../types';
import { notImplemented } from '../util/not-implemented';

export interface CameraObserverOptions {
  classifier: AttentionClassifier;
  /** Used when the profile looks stale (generic classifier); `null` disables the check. */
  fallback: AttentionClassifier | null;
}

export class CameraObserver implements Observer {
  readonly mode: StudyMode = 'camera';

  constructor(_options: CameraObserverOptions) {}

  get classifier(): AttentionClassifier {
    return notImplemented('CameraObserver.classifier');
  }

  /** Swaps the classifier (feedback retrain, recalibration); keeps evidence state. */
  setClassifier(_classifier: AttentionClassifier): void {
    notImplemented('CameraObserver.setClassifier');
  }

  observe(_input: TickInput, _settings: Readonly<StudyAiSettings>): Observation {
    return notImplemented('CameraObserver.observe');
  }

  rescore(_observation: Observation, _settings: Readonly<StudyAiSettings>): number | null {
    return notImplemented('CameraObserver.rescore');
  }

  reset(): void {
    notImplemented('CameraObserver.reset');
  }
}
