/**
 * The vision loader and pipeline with a fake MediaPipe module (Node). The real WASM and models
 * run in RUNTIME's Playwright smoke test (demo/).
 */
import type { FaceLandmarkerOptions, ObjectDetectorOptions } from '@mediapipe/tasks-vision';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_ASSETS, MODEL_MANIFEST } from '../../src/assets';
import type { FrameCanvas } from '../../src/perception/browser/canvas';
import { sha256Hex } from '../../src/perception/browser/hash';
import {
  createVisionPipelineWith,
  VisionLoadError,
  wasmFileset,
  type FaceTask,
  type ObjectTask,
  type TasksVisionModule,
  type VisionRuntime,
  type WasmFilesetLike,
} from '../../src/perception/vision';
import type {
  AnalysisFrame,
  DetectionResultLike,
  ModelManifestEntry,
  VisionAssets,
} from '../../src/types';
import { detection, faceResult, scene } from './fixtures';

/** Bytes with the manifest's size whose hash we make the fake runtime report. */
function fakeModel(entry: ModelManifestEntry): Uint8Array {
  const bytes = new Uint8Array(entry.bytes);
  bytes[0] = entry.id === 'face' ? 1 : 2;
  return bytes;
}
const FACE_BYTES = fakeModel(MODEL_MANIFEST[0]!);
const OBJECT_BYTES = fakeModel(MODEL_MANIFEST[1]!);

/** A 1×1 task canvas whose WebGL context can be lost, like `WEBGL_lose_context` does. */
class FakeTaskCanvas {
  readonly listeners = new Set<() => void>();
  context: { lost: boolean; isContextLost(): boolean } | null = null;
  lookups = 0;
  /** What MediaPipe does on the first frame: creates a WebGL2 context on the canvas. */
  create(): void {
    this.context ??= {
      lost: false,
      isContextLost() {
        return this.lost;
      },
    };
  }
  getContext(type: string): { isContextLost(): boolean } | null {
    this.lookups += 1;
    return type === 'webgl2' ? this.context : null;
  }
  addEventListener(type: string, listener: () => void): void {
    if (type === 'webglcontextlost') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    if (type === 'webglcontextlost') this.listeners.delete(listener);
  }
  /** `WEBGL_lose_context.loseContext()`, optionally without the event. */
  lose(event = true): void {
    if (this.context) this.context.lost = true;
    if (event) for (const listener of this.listeners) listener();
  }
}

interface Calls {
  fetched: string[];
  fileset: WasmFilesetLike[];
  faceOptions: FaceLandmarkerOptions[];
  objectOptions: ObjectDetectorOptions[];
  faceTs: number[];
  objectTs: number[];
  closed: string[];
  luma: number;
  boosts: number[];
  taskCanvases: FakeTaskCanvas[];
}

interface FakeOptions {
  simd?: boolean;
  fetchFails?: boolean;
  wrongHash?: boolean;
  createFails?: 'face' | 'objects';
  detectThrows?: boolean;
  importFails?: boolean;
  objects?: DetectionResultLike;
  /** No OffscreenCanvas: MediaPipe makes its own canvases. */
  noTaskCanvas?: boolean;
}

function fakeRuntime(options: FakeOptions = {}): { runtime: VisionRuntime; calls: Calls } {
  const calls: Calls = {
    fetched: [],
    fileset: [],
    faceOptions: [],
    objectOptions: [],
    faceTs: [],
    objectTs: [],
    closed: [],
    luma: 0,
    boosts: [],
    taskCanvases: [],
  };
  let clock = 0;
  const canvasOf = (opts: { canvas?: unknown }): FakeTaskCanvas | null =>
    opts.canvas instanceof FakeTaskCanvas ? opts.canvas : null;
  let faceCanvas: FakeTaskCanvas | null = null;
  let objectCanvas: FakeTaskCanvas | null = null;
  const face: FaceTask = {
    detectForVideo: (_image, ts) => {
      if (options.detectThrows) throw new Error('wasm abort');
      faceCanvas?.create();
      calls.faceTs.push(ts);
      clock += 9;
      return faceResult([{ box: { cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 }, pitch: -20 }]);
    },
    close: () => calls.closed.push('face'),
  };
  const objects: ObjectTask = {
    detectForVideo: (_image, ts) => {
      objectCanvas?.create();
      calls.objectTs.push(ts);
      clock += 35;
      return (
        options.objects ?? {
          detections: [detection('cell phone', 0.8, { cx: 0.55, cy: 0.75, w: 0.1, h: 0.16 })],
        }
      );
    },
    close: () => calls.closed.push('objects'),
  };
  const tasks: TasksVisionModule = {
    FilesetResolver: { isSimdSupported: async () => options.simd ?? true },
    FaceLandmarker: {
      createFromOptions: async (fileset, opts) => {
        calls.fileset.push(fileset);
        calls.faceOptions.push(opts);
        if (options.createFails === 'face') throw new Error('bad model');
        faceCanvas = canvasOf(opts);
        return face;
      },
    },
    ObjectDetector: {
      createFromOptions: async (fileset, opts) => {
        calls.fileset.push(fileset);
        calls.objectOptions.push(opts);
        if (options.createFails === 'objects') throw new Error('bad model');
        objectCanvas = canvasOf(opts);
        return objects;
      },
    },
  };
  const canvas: FrameCanvas = {
    luma: () => {
      calls.luma += 1;
      return scene();
    },
    boost: (source, _w, _h, gain) => {
      calls.boosts.push(gain);
      return source as TexImageSource;
    },
    clearBoost: () => {},
    release: () => {},
  };
  const runtime: VisionRuntime = {
    importTasks: async () => {
      if (options.importFails) throw new Error('no module');
      return tasks;
    },
    fetchBytes: async (url) => {
      calls.fetched.push(url);
      if (options.fetchFails) throw new Error('HTTP 404');
      return url.endsWith('.task') ? FACE_BYTES : OBJECT_BYTES;
    },
    sha256Hex: async (bytes) => {
      if (options.wrongHash) return '0'.repeat(64);
      if (bytes === FACE_BYTES) return MODEL_MANIFEST[0]!.sha256;
      if (bytes === OBJECT_BYTES) return MODEL_MANIFEST[1]!.sha256;
      return sha256Hex(bytes);
    },
    now: () => clock,
    createCanvas: () => canvas,
    createTaskCanvas: () => {
      if (options.noTaskCanvas) return null;
      const taskCanvas = new FakeTaskCanvas();
      calls.taskCanvases.push(taskCanvas);
      return taskCanvas as unknown as OffscreenCanvas;
    },
  };
  return { runtime, calls };
}

const LOCAL: VisionAssets = {
  wasmBaseUrl: 'http://127.0.0.1:5173/mediapipe/',
  faceModel: { url: 'http://127.0.0.1:5173/models/face_landmarker.task' },
  objectModel: { url: 'http://127.0.0.1:5173/models/efficientdet_lite0_int8.tflite' },
};

function frame(t: number): AnalysisFrame & { closed: number } {
  const f = {
    t,
    width: 320,
    height: 240,
    source: { fake: true },
    closed: 0,
    close() {
      f.closed += 1;
    },
  };
  return f;
}

async function rejection(promise: Promise<unknown>): Promise<VisionLoadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VisionLoadError);
    return error as VisionLoadError;
  }
  throw new Error('expected a rejection');
}

describe('createVisionPipeline (loading)', () => {
  it('builds the SIMD fileset under the base URL', () => {
    expect(wasmFileset('centrate-ai://assets/mediapipe/')).toEqual({
      wasmLoaderPath: 'centrate-ai://assets/mediapipe/vision_wasm_internal.js',
      wasmBinaryPath: 'centrate-ai://assets/mediapipe/vision_wasm_internal.wasm',
    });
  });

  it('loads local models, checks them and configures both tasks', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    expect(calls.fetched).toEqual(
      [LOCAL.faceModel, LOCAL.objectModel].map((m) => 'url' in m && m.url),
    );
    expect(calls.fileset[0]).toEqual({
      wasmLoaderPath: 'http://127.0.0.1:5173/mediapipe/vision_wasm_internal.js',
      wasmBinaryPath: 'http://127.0.0.1:5173/mediapipe/vision_wasm_internal.wasm',
    });
    // Model buffers are compared by identity: a deep compare of megabytes takes minutes.
    const { baseOptions: faceBase, canvas: faceCanvas, ...faceOptions } = calls.faceOptions[0]!;
    const {
      baseOptions: objectBase,
      canvas: objectCanvas,
      ...objectOptions
    } = calls.objectOptions[0]!;
    // Each task renders through its own canvas, so its WebGL context can be watched.
    expect(calls.taskCanvases).toHaveLength(2);
    expect(faceCanvas).toBe(calls.taskCanvases[0]);
    expect(objectCanvas).toBe(calls.taskCanvases[1]);
    expect(faceBase?.delegate).toBe('CPU');
    expect(faceBase?.modelAssetBuffer === FACE_BYTES).toBe(true);
    expect(objectBase?.delegate).toBe('CPU');
    expect(objectBase?.modelAssetBuffer === OBJECT_BYTES).toBe(true);
    expect(faceOptions).toEqual({
      runningMode: 'VIDEO',
      numFaces: 2,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    expect(objectOptions).toEqual({
      runningMode: 'VIDEO',
      scoreThreshold: 0.3,
      maxResults: 6,
      categoryAllowlist: ['person', 'cell phone', 'book'],
    });
    vision.close();
  });

  it('accepts the app asset scheme and model bytes', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(
      { ...ANALYSIS_ASSETS, objectModel: { bytes: OBJECT_BYTES } },
      { numFaces: 1 },
      runtime,
    );
    expect(calls.fetched).toEqual([ANALYSIS_ASSETS.faceModel].map((m) => 'url' in m && m.url));
    expect(calls.faceOptions[0]?.numFaces).toBe(1);
    vision.close();
  });

  it('rejects any non-local URL before loading anything', async () => {
    for (const bad of [
      { ...LOCAL, wasmBaseUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm' },
      { ...LOCAL, faceModel: { url: 'https://storage.googleapis.com/mediapipe-models/x.task' } },
      { ...LOCAL, objectModel: { url: 'file:///tmp/model.tflite' } },
    ]) {
      const { runtime, calls } = fakeRuntime();
      expect((await rejection(createVisionPipelineWith(bad, {}, runtime))).code).toBe(
        'asset_rejected',
      );
      expect(calls.fetched).toEqual([]);
      expect(calls.faceOptions).toEqual([]);
    }
  });

  it('refuses without WASM SIMD', async () => {
    const { runtime, calls } = fakeRuntime({ simd: false });
    expect((await rejection(createVisionPipelineWith(LOCAL, {}, runtime))).code).toBe(
      'simd_unsupported',
    );
    expect(calls.fetched).toEqual([]);
  });

  it('refuses a model whose size or hash differs from the manifest', async () => {
    const { runtime } = fakeRuntime({ wrongHash: true });
    expect((await rejection(createVisionPipelineWith(LOCAL, {}, runtime))).code).toBe(
      'hash_mismatch',
    );
    const short = fakeRuntime();
    const assets = { ...LOCAL, faceModel: { bytes: new Uint8Array(10) } };
    expect((await rejection(createVisionPipelineWith(assets, {}, short.runtime))).code).toBe(
      'hash_mismatch',
    );
  });

  it('checks real SHA-256 digests (Web Crypto)', async () => {
    const bytes = new TextEncoder().encode('céntrate');
    expect(await sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await sha256Hex('céntrate')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('maps fetch, import and task failures to load_failed and closes what started', async () => {
    const fetchFail = fakeRuntime({ fetchFails: true });
    expect((await rejection(createVisionPipelineWith(LOCAL, {}, fetchFail.runtime))).code).toBe(
      'load_failed',
    );
    const importFail = fakeRuntime({ importFails: true });
    expect((await rejection(createVisionPipelineWith(LOCAL, {}, importFail.runtime))).code).toBe(
      'load_failed',
    );
    const objectsFail = fakeRuntime({ createFails: 'objects' });
    expect((await rejection(createVisionPipelineWith(LOCAL, {}, objectsFail.runtime))).code).toBe(
      'load_failed',
    );
    expect(objectsFail.calls.closed).toEqual(['face']);
  });
});

describe('VisionPipeline.process', () => {
  it('runs the face on every frame, objects and luma only when asked', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    const a = vision.process(frame(1_000), { objects: true, luma: true });
    expect(a.features.face?.pose.pitch).toBeCloseTo(-20, 6);
    expect(a.features.objects?.fresh).toBe(true);
    expect(a.features.objects?.phone?.nearFace).toBe(true);
    expect(a.features.luma?.at).toBe(1_000);
    expect(a.cost).toEqual({ faceMs: 9, objectMs: 35, lumaMs: 0, totalMs: 44 });

    const b = vision.process(frame(1_333), { objects: false, luma: false });
    expect(b.features.objects?.fresh).toBe(false);
    expect(b.cost.objectMs).toBe(0);
    expect(calls.faceTs).toHaveLength(2);
    expect(calls.objectTs).toHaveLength(1);
    expect(calls.luma).toBe(1);
    vision.close();
  });

  it('keeps MediaPipe timestamps strictly increasing, also across reset()', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    for (const t of [100.2, 100.4, 99, 250.7, 250.7]) {
      vision.process(frame(t), { objects: true, luma: false });
    }
    vision.reset();
    vision.process(frame(10), { objects: true, luma: false });
    expect(calls.faceTs).toEqual([100, 101, 102, 251, 252, 253]);
    expect(calls.objectTs).toEqual([100, 101, 102, 251, 252, 253]);
    vision.close();
  });

  it('never closes the frame (the loop does)', async () => {
    const { runtime } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    const f = frame(0);
    vision.process(f, { objects: true, luma: true });
    expect(f.closed).toBe(0);
    vision.close();
  });

  it('turns inference errors into process_failed', async () => {
    const { runtime } = fakeRuntime({ detectThrows: true });
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    expect(() => vision.process(frame(0), { objects: false, luma: false })).toThrow(
      VisionLoadError,
    );
    try {
      vision.process(frame(1), { objects: false, luma: false });
    } catch (error) {
      expect((error as VisionLoadError).code).toBe('process_failed');
    }
    vision.close();
  });

  it('brightens inputs after 5 s of low light, unless disabled', async () => {
    const dark = fakeRuntime();
    const darkCanvas = dark.runtime.createCanvas()!;
    darkCanvas.luma = () => ({
      width: 32,
      height: 24,
      data: new Uint8Array(768).map((_, i) => 20 + (i % 2) * 20),
    });
    dark.runtime.createCanvas = () => darkCanvas;
    const vision = await createVisionPipelineWith(LOCAL, {}, dark.runtime);
    for (let t = 0; t <= 7_000; t += 1_000)
      vision.process(frame(t), { objects: false, luma: true });
    expect(dark.calls.boosts.length).toBeGreaterThan(0);
    expect(dark.calls.boosts[0]).toBeGreaterThan(1);
    vision.close();

    const off = fakeRuntime();
    off.runtime.createCanvas = () => darkCanvas;
    const plain = await createVisionPipelineWith(LOCAL, { lowLightBoost: false }, off.runtime);
    for (let t = 0; t <= 7_000; t += 1_000) plain.process(frame(t), { objects: false, luma: true });
    expect(off.calls.boosts).toEqual([]);
    plain.close();
  });

  it('WebGL context lost (GPU reset): process throws contextLost before running a model', async () => {
    for (const which of [0, 1]) {
      const { runtime, calls } = fakeRuntime();
      const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
      vision.process(frame(0), { objects: true, luma: true });
      expect(vision.contextLost).toBe(false);
      calls.taskCanvases[which]!.lose();
      expect(vision.contextLost).toBe(true);
      const ran = calls.faceTs.length;
      let error: unknown = null;
      try {
        vision.process(frame(333), { objects: true, luma: true });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(VisionLoadError);
      expect((error as VisionLoadError).code).toBe('process_failed');
      expect((error as VisionLoadError).contextLost).toBe(true);
      expect(calls.faceTs).toHaveLength(ran); // no model ran on the lost context
      vision.close();
      expect(calls.taskCanvases.every((c) => c.listeners.size === 0)).toBe(true);
    }
  });

  it('sees a lost context without the event, and never creates a context itself', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    // Before the first frame the contexts are not looked up (MediaPipe creates them).
    expect(calls.taskCanvases.map((c) => c.lookups)).toEqual([0, 0]);
    vision.process(frame(0), { objects: false, luma: false });
    calls.taskCanvases[0]!.lose(false);
    expect(() => vision.process(frame(333), { objects: false, luma: false })).toThrow(
      /webgl context lost/,
    );
    // The object task's context is looked up once it has run.
    const other = fakeRuntime();
    const v2 = await createVisionPipelineWith(LOCAL, {}, other.runtime);
    v2.process(frame(0), { objects: true, luma: false });
    other.calls.taskCanvases[1]!.lose(false);
    expect(v2.contextLost).toBe(true);
    vision.close();
    v2.close();
  });

  it('other inference errors are not context losses; without task canvases nothing is watched', async () => {
    const failing = fakeRuntime({ detectThrows: true });
    const vision = await createVisionPipelineWith(LOCAL, {}, failing.runtime);
    try {
      vision.process(frame(0), { objects: false, luma: false });
    } catch (error) {
      expect((error as VisionLoadError).contextLost).toBe(false);
    }
    vision.close();
    const plain = fakeRuntime({ noTaskCanvas: true });
    const v2 = await createVisionPipelineWith(LOCAL, {}, plain.runtime);
    expect('canvas' in plain.calls.faceOptions[0]!).toBe(false);
    expect(v2.process(frame(0), { objects: true, luma: false }).features.face).not.toBeNull();
    expect(v2.contextLost).toBe(false);
    v2.close();
  });

  it('close() is idempotent and process() afterwards fails', async () => {
    const { runtime, calls } = fakeRuntime();
    const vision = await createVisionPipelineWith(LOCAL, {}, runtime);
    vision.close();
    vision.close();
    expect(calls.closed).toEqual(['face', 'objects']);
    expect(() => vision.process(frame(0), { objects: false, luma: false })).toThrow(/closed/);
  });
});
