/**
 * @centrate/study-ai/runtime: renderer entry (the hidden analysis window and the demo).
 * Everything from the pure entry plus camera, MediaPipe and the session facades. Never import
 * this from Electron main. MediaPipe itself is loaded lazily inside `createVisionPipeline`.
 */
export * from './index';

// PERCEPTION (browser)
export { CameraOpenError, listCameras, openCamera } from './perception/camera'; // stub
export { VisionLoadError, createVisionPipeline } from './perception/vision'; // stub

// RUNTIME (browser)
export { startStudySession } from './runtime/session'; // stub
export { startCalibration } from './runtime/calibration-session'; // stub
export { createAnalysisHost } from './runtime/analysis-host'; // stub
