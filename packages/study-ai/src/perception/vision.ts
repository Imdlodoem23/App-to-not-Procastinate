/**
 * [browser] MediaPipe loading and per-frame inference (owner: PERCEPTION). The only file that
 * imports `@mediapipe/tasks-vision` as a value, and only through a dynamic `import()`.
 * DESIGN.md §5.1–5.2.
 *
 * Loading, in order:
 * 1. every URL must pass `isAllowedAssetUrl` (the app's asset scheme or loopback);
 * 2. WASM SIMD must be supported (only the SIMD runtime is shipped);
 * 3. each model is fetched locally (or given as bytes) and checked against `MODEL_MANIFEST`
 *    (size and SHA-256) before MediaPipe sees it;
 * 4. both tasks run on the CPU delegate in VIDEO mode.
 *
 * Inference is synchronous. Only numbers (`FrameFeatures`) leave `process`; the frame,
 * landmarks and blendshapes stay in its scope.
 *
 * WebGL: even on the CPU delegate, MediaPipe 1.0.1 uploads every frame as a WebGL texture and
 * reads it back, on a WebGL2 context of the task's canvas. Each task gets its own canvas
 * from here, so the pipeline can see that context being lost (GPU process crash or reset,
 * resume from sleep, a hybrid-GPU switch). MediaPipe does not notice: it keeps returning
 * empty results, which would read as «nobody there». `process` throws `contextLost` instead,
 * and the session rebuilds the pipeline.
 */
import type { FaceLandmarkerOptions, ObjectDetectorOptions } from '@mediapipe/tasks-vision';
import { isAllowedAssetUrl, MEDIAPIPE_WASM_FILES, MODEL_MANIFEST } from '../assets';
import type {
  AnalysisFrame,
  DetectionResultLike,
  FaceLandmarkerResultLike,
  GrayThumbnail,
  ModelManifestEntry,
  ModelSource,
  RawVisionInput,
  VisionAssets,
  VisionCost,
  VisionErrorCode,
  VisionFrameOptions,
  VisionPipeline,
  VisionPipelineOptions,
  VisionResult,
} from '../types';
import { createFrameCanvas, type FrameCanvas } from './browser/canvas';
import { sha256Hex } from './browser/hash';
import { FACE_LANDMARKER_OPTIONS, OBJECT_CATEGORIES, OBJECT_DETECTOR_OPTIONS } from './constants';
import { FeatureExtractor } from './extractor';

export class VisionLoadError extends Error {
  readonly code: VisionErrorCode;
  /** The WebGL context MediaPipe runs through was lost: rebuild the pipeline. */
  readonly contextLost: boolean;
  constructor(code: VisionErrorCode, message?: string, options: { contextLost?: boolean } = {}) {
    super(message ?? code);
    this.name = 'VisionLoadError';
    this.code = code;
    this.contextLost = options.contextLost === true;
  }
}

// ---------------------------------------------------------------------------------------
// The slice of @mediapipe/tasks-vision this file uses (structural, so tests can fake it)
// ---------------------------------------------------------------------------------------

export interface WasmFilesetLike {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}

interface VideoTask<R> {
  detectForVideo(image: TexImageSource, timestamp: number): R;
  close(): void;
}

export type FaceTask = VideoTask<FaceLandmarkerResultLike>;
export type ObjectTask = VideoTask<DetectionResultLike>;

export interface TasksVisionModule {
  FilesetResolver: { isSimdSupported(useModule?: boolean): Promise<boolean> };
  FaceLandmarker: {
    createFromOptions(fileset: WasmFilesetLike, options: FaceLandmarkerOptions): Promise<FaceTask>;
  };
  ObjectDetector: {
    createFromOptions(
      fileset: WasmFilesetLike,
      options: ObjectDetectorOptions,
    ): Promise<ObjectTask>;
  };
}

/** What `createVisionPipeline` needs from the browser; tests pass fakes. */
export interface VisionRuntime {
  importTasks(): Promise<TasksVisionModule>;
  /** Bytes of a local URL (already checked by `isAllowedAssetUrl`). */
  fetchBytes(url: string): Promise<Uint8Array>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  now(): number;
  createCanvas(): FrameCanvas | null;
  /**
   * A 1×1 canvas for one MediaPipe task's WebGL context (the task creates the context on it),
   * or `null` to let MediaPipe create its own (then context loss cannot be seen).
   */
  createTaskCanvas(): OffscreenCanvas | null;
}

const BROWSER_RUNTIME: VisionRuntime = {
  importTasks: async (): Promise<TasksVisionModule> => {
    const tasks: TasksVisionModule = await import('@mediapipe/tasks-vision');
    return tasks;
  },
  fetchBytes: async (url) => {
    // Local only: no cookies, no redirect to anywhere else.
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  sha256Hex,
  now: () => performance.now(),
  createCanvas: createFrameCanvas,
  createTaskCanvas: () =>
    typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1),
};

// ---------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function manifestEntry(id: ModelManifestEntry['id']): ModelManifestEntry {
  const entry = MODEL_MANIFEST.find((m) => m.id === id);
  if (!entry) throw new VisionLoadError('load_failed', `no manifest entry for ${id}`);
  return entry;
}

/** The SIMD runtime files under `base` (no trailing slash). */
export function wasmFileset(base: string): WasmFilesetLike {
  const root = base.replace(/\/+$/, '');
  const [loader, binary] = MEDIAPIPE_WASM_FILES;
  return { wasmLoaderPath: `${root}/${loader}`, wasmBinaryPath: `${root}/${binary}` };
}

function checkUrls(assets: VisionAssets): WasmFilesetLike {
  const fileset = wasmFileset(assets.wasmBaseUrl);
  const urls = [assets.wasmBaseUrl, fileset.wasmLoaderPath, fileset.wasmBinaryPath];
  for (const model of [assets.faceModel, assets.objectModel]) {
    if ('url' in model) urls.push(model.url);
  }
  for (const url of urls) {
    if (typeof url !== 'string' || !isAllowedAssetUrl(url)) {
      throw new VisionLoadError('asset_rejected', `not a local asset URL: ${String(url)}`);
    }
  }
  return fileset;
}

async function loadModel(
  source: ModelSource,
  entry: ModelManifestEntry,
  runtime: VisionRuntime,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if ('bytes' in source) {
    bytes = source.bytes;
  } else {
    try {
      bytes = await runtime.fetchBytes(source.url);
    } catch (error) {
      throw new VisionLoadError('load_failed', `${entry.file}: ${message(error)}`);
    }
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.bytes) {
    throw new VisionLoadError('hash_mismatch', `${entry.file}: unexpected size`);
  }
  let hex: string;
  try {
    hex = await runtime.sha256Hex(bytes);
  } catch (error) {
    throw new VisionLoadError('load_failed', `${entry.file}: cannot hash (${message(error)})`);
  }
  if (hex !== entry.sha256) throw new VisionLoadError('hash_mismatch', `${entry.file}: sha256`);
  return bytes;
}

/** Loads the WASM and both models (sha256-checked, local URLs only). */
export function createVisionPipeline(
  assets: VisionAssets,
  options: VisionPipelineOptions = {},
): Promise<VisionPipeline> {
  return createVisionPipelineWith(assets, options, BROWSER_RUNTIME);
}

/** `createVisionPipeline` with an explicit runtime (tests; not part of the public entry). */
export async function createVisionPipelineWith(
  assets: VisionAssets,
  options: VisionPipelineOptions,
  runtime: VisionRuntime,
): Promise<VisionPipeline> {
  const fileset = checkUrls(assets);

  let tasks: TasksVisionModule;
  try {
    tasks = await runtime.importTasks();
  } catch (error) {
    throw new VisionLoadError('load_failed', `MediaPipe: ${message(error)}`);
  }

  const simd = await tasks.FilesetResolver.isSimdSupported().catch(() => false);
  if (simd !== true) throw new VisionLoadError('simd_unsupported');

  const [faceBytes, objectBytes] = await Promise.all([
    loadModel(assets.faceModel, manifestEntry('face'), runtime),
    loadModel(assets.objectModel, manifestEntry('objects'), runtime),
  ]);

  let face: FaceTask | null = null;
  let objects: ObjectTask | null = null;
  const faceGl = new GlWatch(runtime.createTaskCanvas());
  const objectGl = new GlWatch(runtime.createTaskCanvas());
  try {
    face = await tasks.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceBytes, delegate: 'CPU' },
      ...FACE_LANDMARKER_OPTIONS,
      numFaces: options.numFaces === 1 ? 1 : 2,
      ...faceGl.option,
    });
    objects = await tasks.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: objectBytes, delegate: 'CPU' },
      ...OBJECT_DETECTOR_OPTIONS,
      categoryAllowlist: [...OBJECT_CATEGORIES],
      ...objectGl.option,
    });
  } catch (error) {
    safeClose(face);
    safeClose(objects);
    faceGl.release();
    objectGl.release();
    throw new VisionLoadError('load_failed', `MediaPipe tasks: ${message(error)}`);
  }

  return new MediaPipeVision(
    { task: face, gl: faceGl },
    { task: objects, gl: objectGl },
    runtime,
    options.lowLightBoost !== false,
  );
}

function safeClose(task: { close(): void } | null): void {
  try {
    task?.close();
  } catch {
    // already closed or never started
  }
}

// ---------------------------------------------------------------------------------------
// WebGL context loss
// ---------------------------------------------------------------------------------------

interface GlContextLike {
  isContextLost(): boolean;
}

/**
 * Watches the WebGL context of one task's canvas: the `webglcontextlost` event, and
 * `isContextLost()` of the context the task created. The context is only looked up after the
 * task has run once, so this never creates one or changes its attributes.
 */
class GlWatch {
  private context: GlContextLike | null = null;
  private lostEvent = false;
  private readonly onLost = (): void => {
    this.lostEvent = true;
  };

  constructor(private readonly canvas: OffscreenCanvas | null) {
    canvas?.addEventListener('webglcontextlost', this.onLost);
  }

  /** The `canvas` task option (empty without a canvas: MediaPipe makes its own). */
  get option(): { canvas?: OffscreenCanvas } {
    return this.canvas === null ? {} : { canvas: this.canvas };
  }

  /** Takes the context the task created on its canvas (after the task's first run). */
  attach(): void {
    if (this.canvas === null || this.context !== null) return;
    try {
      this.context = this.canvas.getContext('webgl2') ?? this.canvas.getContext('webgl');
    } catch {
      this.context = null;
    }
  }

  get lost(): boolean {
    if (this.lostEvent) return true;
    try {
      return this.context?.isContextLost() === true;
    } catch {
      return true;
    }
  }

  release(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.onLost);
    this.context = null;
  }
}

interface WatchedTask<T> {
  task: T;
  gl: GlWatch;
}

const contextLostError = (): VisionLoadError =>
  new VisionLoadError('process_failed', 'webgl context lost', { contextLost: true });

// ---------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------

class MediaPipeVision implements VisionPipeline {
  private readonly extractor = new FeatureExtractor();
  private readonly canvas: FrameCanvas | null;
  private lastFaceTs = -Infinity;
  private lastObjectTs = -Infinity;
  private closed = false;

  constructor(
    private readonly face: WatchedTask<FaceTask>,
    private readonly objects: WatchedTask<ObjectTask>,
    private readonly runtime: VisionRuntime,
    private readonly lowLightBoost: boolean,
  ) {
    this.canvas = runtime.createCanvas();
  }

  get contextLost(): boolean {
    return this.face.gl.lost || this.objects.gl.lost;
  }

  process(frame: AnalysisFrame, options: VisionFrameOptions): VisionResult {
    if (this.closed) throw new VisionLoadError('process_failed', 'vision pipeline closed');
    // A lost context gives empty results, not errors: never run the models on it.
    if (this.contextLost) throw contextLostError();
    const start = this.runtime.now();
    const t = Number.isFinite(frame.t) ? frame.t : start;
    const cost: VisionCost = { faceMs: 0, objectMs: 0, lumaMs: 0, totalMs: 0 };
    let raw: Pick<RawVisionInput, 'face' | 'objects' | 'gray'>;
    try {
      raw = this.infer(frame, t, options, cost);
    } catch (error) {
      this.canvas?.clearBoost();
      if (this.contextLost) throw contextLostError();
      throw new VisionLoadError('process_failed', message(error));
    }
    // Lost during this frame: its results are not trustworthy either.
    if (this.contextLost) throw contextLostError();
    const features = this.extractor.extract({
      t,
      width: frame.width,
      height: frame.height,
      ...raw,
    });
    cost.totalMs = this.runtime.now() - start;
    return { features, cost };
  }

  /** MediaPipe calls and the luma thumbnail; fills `cost`. The results stay in this scope. */
  private infer(
    frame: AnalysisFrame,
    t: number,
    options: VisionFrameOptions,
    cost: VisionCost,
  ): Pick<RawVisionInput, 'face' | 'objects' | 'gray'> {
    const now = (): number => this.runtime.now();
    const source = frame.source as TexImageSource & CanvasImageSource;
    const gain = this.lowLightBoost ? this.extractor.lowLightGain : 1;
    const input =
      gain > 1 && this.canvas !== null
        ? (this.canvas.boost(source, frame.width, frame.height, gain) ?? source)
        : source;

    const faceStart = now();
    this.lastFaceTs = Math.max(this.lastFaceTs + 1, Math.round(t));
    const face = this.face.task.detectForVideo(input, this.lastFaceTs);
    this.face.gl.attach();
    cost.faceMs = now() - faceStart;

    let objects: DetectionResultLike | null = null;
    if (options.objects) {
      const objectStart = now();
      this.lastObjectTs = Math.max(this.lastObjectTs + 1, Math.round(t));
      objects = this.objects.task.detectForVideo(input, this.lastObjectTs);
      this.objects.gl.attach();
      cost.objectMs = now() - objectStart;
    }

    if (input !== source) this.canvas?.clearBoost();

    let gray: GrayThumbnail | null = null;
    if (options.luma && this.canvas !== null) {
      // Measured on the raw frame: the scene's real light, not the boosted one.
      const lumaStart = now();
      gray = this.canvas.luma(source);
      cost.lumaMs = now() - lumaStart;
    }
    return { face: face ?? { faceLandmarks: [] }, objects, gray };
  }

  reset(): void {
    // MediaPipe timestamps keep increasing for the tasks' whole life, so they are kept.
    this.extractor.reset();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    safeClose(this.face.task);
    safeClose(this.objects.task);
    this.face.gl.release();
    this.objects.gl.release();
    this.canvas?.release();
    this.extractor.reset();
  }
}
