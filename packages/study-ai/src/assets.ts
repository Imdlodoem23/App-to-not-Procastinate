/**
 * Offline assets of the vision pipeline (owner: PERCEPTION). Pure constants plus the URL rule
 * that keeps every load on this machine. Hashes and sizes were verified on 2026-09-28.
 */
import type { ModelManifestEntry, VisionAssets } from './types';

export const MEDIAPIPE_VERSION = '1.0.1';

/** Only the SIMD pair is shipped (Electron's Chromium always has WASM SIMD). */
export const MEDIAPIPE_WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
] as const;

/**
 * Size and SHA-256 of the SIMD pair of `MEDIAPIPE_VERSION`, as published on npm. The
 * fetch-models script refuses to copy anything else into the app's resources.
 */
export const MEDIAPIPE_WASM_DIGESTS: Readonly<
  Record<(typeof MEDIAPIPE_WASM_FILES)[number], Readonly<{ sha256: string; bytes: number }>>
> = Object.freeze({
  'vision_wasm_internal.js': Object.freeze({
    sha256: 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73',
    bytes: 323_377,
  }),
  'vision_wasm_internal.wasm': Object.freeze({
    sha256: '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
    bytes: 11_756_954,
  }),
});

/**
 * Hosts the MediaPipe bundle can contact. Its usage logger POSTs task type, OS, version and
 * latency stats to this host every 60 s and cannot be disabled from code, so the analysis
 * window blocks all network (CSP + session.webRequest). A test fails if the bundle ever
 * contains another URL.
 */
export const MEDIAPIPE_NETWORK_HOSTS = ['odml.pa.googleapis.com'] as const;

/** Repo-relative folder holding the committed model files and `manifest.json`. */
export const MODELS_DIR = 'apps/desktop/resources/models';

/**
 * Sub-folder of `MODELS_DIR` where fetch-models copies the WASM pair from node_modules
 * (git-ignored: 12 MB that npm already pins).
 */
export const MEDIAPIPE_WASM_SUBDIR = 'mediapipe';

export const MODEL_MANIFEST: readonly ModelManifestEntry[] = Object.freeze([
  Object.freeze({
    id: 'face',
    name: 'MediaPipe Face Landmarker (float16, v1)',
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    bytes: 3_758_596,
    license: 'Apache-2.0',
  }),
  Object.freeze({
    id: 'objects',
    name: 'EfficientDet-Lite0 (int8, v1, COCO 2017)',
    file: 'efficientdet_lite0_int8.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
    sha256: '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb',
    bytes: 4_602_795,
    license: 'Apache-2.0',
  }),
] satisfies ModelManifestEntry[]);

/** Privileged scheme the desktop registers for the analysis window (see HANDOFF.md). */
export const ANALYSIS_ASSET_SCHEME = 'centrate-ai';

/** Asset URLs the desktop serves through `centrate-ai://assets/…`. */
export const ANALYSIS_ASSETS: Readonly<VisionAssets> = Object.freeze({
  wasmBaseUrl: `${ANALYSIS_ASSET_SCHEME}://assets/mediapipe`,
  faceModel: Object.freeze({
    url: `${ANALYSIS_ASSET_SCHEME}://assets/models/face_landmarker.task`,
  }),
  objectModel: Object.freeze({
    url: `${ANALYSIS_ASSET_SCHEME}://assets/models/efficientdet_lite0_int8.tflite`,
  }),
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True only for URLs that stay on this machine: the app's asset scheme, or http(s) on a
 * loopback host (Vite dev server, the demo). Everything else is rejected before any load.
 */
export function isAllowedAssetUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.protocol === `${ANALYSIS_ASSET_SCHEME}:`) return parsed.hostname === 'assets';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }
  return false;
}
