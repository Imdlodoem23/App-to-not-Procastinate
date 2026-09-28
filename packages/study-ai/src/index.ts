/**
 * @centrate/study-ai: pure entry. Node-safe and DOM-free (typechecked with lib ES2023 only by
 * tsconfig.pure.json): the Electron main process, the tests and the analysis window can all
 * import it. Camera, MediaPipe and the session facades live in `@centrate/study-ai/runtime`.
 *
 * Modules still marked "stub" throw `not implemented` until their builder lands them.
 */

// Types and vocabularies (lead)
export * from './types';

// Settings and shared constants (lead)
export {
  DEFAULT_STUDY_AI_SETTINGS,
  STUDY_AI_CONSTANTS,
  STUDY_AI_RANGES,
  resolveStudyAiSettings,
} from './config';
export type { StudyAiConstants } from './config';
export { MONOTONIC_CLOCK, REAL_TIMERS } from './util/time';

// PERCEPTION (pure parts)
export {
  ANALYSIS_ASSETS,
  ANALYSIS_ASSET_SCHEME,
  MEDIAPIPE_NETWORK_HOSTS,
  MEDIAPIPE_VERSION,
  MEDIAPIPE_WASM_FILES,
  MODELS_DIR,
  MODEL_MANIFEST,
  isAllowedAssetUrl,
} from './assets';
export { poseFromMatrix } from './perception/pose'; // stub
export { FeatureExtractor } from './perception/extractor'; // stub
export type { FeatureExtractorOptions } from './perception/extractor';

// LEARNING
export { frameToRow } from './classifier/rows'; // stub
export { createPersonalClassifier } from './classifier/personal'; // stub
export { createGenericClassifier } from './classifier/generic'; // stub
export type { GenericClassifierOptions } from './classifier/generic';
export { CalibrationRecorder } from './calibration/recorder'; // stub
export {
  PROFILE_TRAINER_VERSION,
  buildProfile,
  parseProfile,
  profileMatchesCamera,
  serializeProfile,
} from './calibration/profile'; // stub
export { learnFromFeedback } from './calibration/feedback'; // stub
// The wizard checklist and the saved clips, for Electron main (never retrains).
export { calibrationSteps, nextPendingSituation, profileStatus } from './calibration/status';
export type {
  CalibrationStep,
  CalibrationStepState,
  CalibrationStepsInput,
  ProfileStatus,
  RecordedSituation,
} from './calibration/status';

// DECISION
export { CameraObserver } from './score/camera-observer'; // stub
export type { CameraObserverOptions } from './score/camera-observer';
export { AttentionEngine } from './state/engine'; // stub
export { heartbeatState, strikeCauseFor } from './state/heartbeat-state'; // stub
export { bucketizeTimeline } from './state/timeline'; // stub

// RUNTIME (pure parts: also used by Electron main)
export { NoCameraObserver } from './runtime/no-camera'; // stub
export { CpuGovernor, DEFAULT_CPU_BUDGET, LOOP_LEVELS, START_LEVEL } from './runtime/governor'; // stub
export { AdaptiveLoop } from './runtime/loop'; // stub
export type { LoopStep } from './runtime/loop';
export { HeartbeatAccumulator } from './runtime/heartbeat'; // stub
export { isAnalysisInbound, isAnalysisOutbound } from './runtime/ipc'; // stub
