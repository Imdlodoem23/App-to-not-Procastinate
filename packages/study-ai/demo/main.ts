/**
 * Manual-test page: the real camera, MediaPipe and the whole study session in a normal
 * browser tab, showing numbers only. Plays the part of Electron main: sends the context at
 * 1 Hz, acknowledges strikes like the guardian would (counted, 60 s cooldown) and keeps the
 * profile in memory (download/upload as a local JSON file).
 *
 * `window.__studyAiDemo` exposes counters for the Playwright smoke test (demo/smoke.pw.ts).
 */
import { parseProfile } from '../src/calibration/profile';
import { STUDY_AI_CONSTANTS } from '../src/config';
import { createVisionPipeline } from '../src/perception/vision';
import { startCalibration } from '../src/runtime/calibration-session';
import {
  startStudySessionWith,
  type CameraObserverPort,
  type SessionParts,
} from '../src/runtime/session';
import { CameraObserver } from '../src/score/camera-observer';
import { CALIBRATION_CLASSES } from '../src/types';
import type {
  AttentionClassifier,
  CalibrationClass,
  CalibrationSessionHandle,
  ContextInput,
  ForegroundClass,
  FrameFeatures,
  Observation,
  SessionDeps,
  SessionEvent,
  SessionReport,
  StudyAiSettings,
  StudyMode,
  StudyPhase,
  StudySessionHandle,
  TickInput,
  VisionAssets,
  VisionCost,
  VisionPipeline,
  VisionPipelineOptions,
} from '../src/types';

// ---------------------------------------------------------------------------------------
// Probe for the smoke test
// ---------------------------------------------------------------------------------------

interface DemoProbe {
  running: boolean;
  frames: number;
  nonFinite: number;
  reports: number;
  lastReport: SessionReport | null;
  /** `performance.now()` of the last 200 analysed frames. */
  frameTimes: number[];
  /** Inference cost of the last frame (ms). */
  lastCost: VisionCost | null;
  events: string[];
  /** URLs the page's CSP refused (nothing may leave this machine). */
  blocked: string[];
  error: string | null;
  start(mode: StudyMode): Promise<void>;
  stop(): Promise<void>;
}

const probe: DemoProbe = {
  running: false,
  frames: 0,
  nonFinite: 0,
  reports: 0,
  lastReport: null,
  lastCost: null,
  frameTimes: [],
  events: [],
  blocked: [],
  error: null,
  start: (mode) => startSession(mode),
  stop: () => stopSession(),
};
(window as unknown as { __studyAiDemo: DemoProbe }).__studyAiDemo = probe;

document.addEventListener('securitypolicyviolation', (event) => {
  probe.blocked.push(event.blockedURI);
  log(`Bloqueado por la CSP: ${event.blockedURI}`);
});

// ---------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function text(id: string, value: string): void {
  el(id).textContent = value;
}

const num = (value: number | null | undefined, digits = 1): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';

const secs = (ms: number | null): string =>
  ms === null ? '—' : `${Math.ceil(Math.max(0, ms) / 1_000)} s`;

const clock = (): string => {
  const d = new Date();
  return d.toLocaleTimeString('es-ES', { hour12: false });
};

function log(message: string): void {
  const list = el<HTMLOListElement>('events');
  const item = document.createElement('li');
  item.textContent = `${clock()} · ${message}`;
  list.prepend(item);
  while (list.children.length > 60) list.lastElementChild?.remove();
}

// ---------------------------------------------------------------------------------------
// Assets, idle time and context (what Electron main does in the app)
// ---------------------------------------------------------------------------------------

const ASSETS: VisionAssets = {
  wasmBaseUrl: `${location.origin}/mediapipe`,
  faceModel: { url: `${location.origin}/models/face_landmarker.task` },
  objectModel: { url: `${location.origin}/models/efficientdet_lite0_int8.tflite` },
};

let lastInputAt = performance.now();
for (const type of ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart']) {
  window.addEventListener(type, () => {
    lastInputAt = performance.now();
  });
}

function context(): ContextInput {
  return {
    phase: el<HTMLSelectElement>('phase').value as StudyPhase,
    foreground: el<HTMLSelectElement>('foreground').value as ForegroundClass,
    idleMs: Math.round(performance.now() - lastInputAt),
  };
}

function settings(): Partial<StudyAiSettings> {
  return { focusScoreThreshold: Number(el<HTMLInputElement>('sensitivity').value) };
}

// ---------------------------------------------------------------------------------------
// Instrumented vision and observer (numbers only)
// ---------------------------------------------------------------------------------------

let lastFeaturesPaint = 0;

function countNonFinite(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? 0 : 1;
  if (typeof value !== 'object' || value === null) return 0;
  let n = 0;
  for (const child of Object.values(value)) n += countNonFinite(child);
  return n;
}

function onFeatures(features: FrameFeatures, cost: VisionCost): void {
  probe.frames += 1;
  probe.nonFinite += countNonFinite(features);
  probe.lastCost = cost;
  probe.frameTimes.push(performance.now());
  if (probe.frameTimes.length > 200) probe.frameTimes.shift();
  const now = performance.now();
  if (now - lastFeaturesPaint < 250) return;
  lastFeaturesPaint = now;
  const face = features.face;
  text(
    'pose',
    face
      ? `${num(face.pose.yaw)}° · ${num(face.pose.pitch)}° · ${num(face.pose.roll)}°`
      : 'sin cara',
  );
  text('eyes', face ? `${num(face.blink, 2)} · ${num(face.lookDown, 2)}` : '—');
  text('face-meta', `${face?.faces ?? 0} · ${num(features.quality, 2)}`);
  const objects = features.objects;
  const phone = objects?.phone;
  text(
    'phone',
    phone
      ? `${num(phone.score, 2)}${phone.nearFace ? ' · cerca de la cara' : ''}${phone.moving ? ' · moviéndose' : ''}`
      : objects
        ? 'no'
        : '—',
  );
  text(
    'book-person',
    objects ? `${num(objects.book?.score ?? 0, 2)} · ${num(objects.person?.score ?? 0, 2)}` : '—',
  );
  const luma = features.luma;
  text(
    'luma',
    luma
      ? `${num(luma.mean, 2)}${luma.covered ? ' · tapada' : ''}${luma.lowLight ? ' · poca luz' : ''}`
      : '—',
  );
  text(
    'cost',
    `cara ${num(cost.faceMs)} ms · objetos ${num(cost.objectMs)} ms · luz ${num(cost.lumaMs)} ms`,
  );
}

async function instrumentedVision(
  assets: VisionAssets,
  options?: VisionPipelineOptions,
): Promise<VisionPipeline> {
  const inner = await createVisionPipeline(assets, options);
  return {
    process(frame, frameOptions) {
      const result = inner.process(frame, frameOptions);
      onFeatures(result.features, result.cost);
      return result;
    },
    reset: () => inner.reset(),
    close: () => inner.close(),
  };
}

function onObservation(observation: Observation): void {
  text('instant', observation.study === null ? 'fuera de la ventana' : num(observation.study, 2));
  const e = observation.evidence;
  const flags = [
    e.phone ? 'móvil' : null,
    e.book ? 'libro' : null,
    e.lookingDown ? 'mirando abajo' : null,
    e.distractionApp ? 'distracción' : null,
    e.inputActive ? 'teclado/ratón' : null,
    observation.eyes.closed ? 'ojos cerrados' : null,
  ].filter((f): f is string => f !== null);
  text('evidence', flags.length > 0 ? flags.join(' · ') : 'nada');
}

/** The real camera observer, reporting each observation to the page. */
class ObservedCameraObserver implements CameraObserverPort {
  readonly mode = 'camera' as const;
  constructor(private readonly inner: CameraObserver) {}
  get classifier(): AttentionClassifier {
    return this.inner.classifier;
  }
  setClassifier(classifier: AttentionClassifier): void {
    this.inner.setClassifier(classifier);
  }
  observe(input: TickInput, s: Readonly<StudyAiSettings>): Observation {
    const observation = this.inner.observe(input, s);
    onObservation(observation);
    return observation;
  }
  rescore(observation: Observation, s: Readonly<StudyAiSettings>): number | null {
    return this.inner.rescore(observation, s);
  }
  reset(): void {
    this.inner.reset();
  }
}

const PARTS: Partial<SessionParts> = {
  createCameraObserver: (options) => new ObservedCameraObserver(new CameraObserver(options)),
};

const DEPS: Partial<SessionDeps> = { createVision: instrumentedVision };

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------

let session: StudySessionHandle | null = null;
let contextTimer: ReturnType<typeof setTimeout> | null = null;
let profileJson: string | null = null;

function setRunning(running: boolean): void {
  probe.running = running;
  el<HTMLButtonElement>('start-camera').disabled = running;
  el<HTMLButtonElement>('start-no-camera').disabled = running;
  el<HTMLButtonElement>('stop').disabled = !running;
  el<HTMLButtonElement>('feedback').disabled = !running;
  el<HTMLButtonElement>('no-camera').disabled = !running;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-record]')) {
    button.disabled = running;
  }
}

function sendContext(): void {
  session?.setContext(context());
  contextTimer = setTimeout(sendContext, 1_000);
}

function onEvent(event: SessionEvent): void {
  probe.events.push(event.type);
  switch (event.type) {
    case 'state':
      log(`Estado: ${event.from} → ${event.to}`);
      return;
    case 'warning':
      log(event.kind === 'doubt' ? 'Aviso: «¿Sigues ahí?»' : 'Aviso: «No te veo»');
      return;
    case 'doubt_cleared':
      log(`DUDA resuelta (${event.by === 'feedback' ? '«¡Estaba estudiando!»' : 'puntuación'})`);
      return;
    case 'strike': {
      log(`STRIKE ${event.seq}: ${event.cause}`);
      // What main + the guardian answer: counted, with the 60 s cooldown.
      const seq = event.seq;
      setTimeout(() => {
        session?.strikeResult({
          seq,
          counted: true,
          reason: null,
          cooldownLeftMs: STUDY_AI_CONSTANTS.strikeGraceMs,
        });
      }, 50);
      return;
    }
    case 'suggest_break':
      log(`Sugerencia de descanso (${event.reason})`);
      return;
    case 'hint':
      log(`Aviso ${event.code}: ${event.active ? 'activo' : 'resuelto'}`);
      return;
    case 'profile_updated':
      profileJson = event.profileJson;
      showProfile();
      log(`Perfil actualizado (${event.reason})`);
      return;
    case 'camera':
      log(`Cámara: ${event.status}${event.error ? ` (${event.error})` : ''}`);
      el<HTMLButtonElement>('no-camera').disabled = event.status !== 'error';
      return;
    case 'mode':
      log(`Modo: ${event.mode} (${event.reason})`);
      return;
  }
}

function onReport(report: SessionReport): void {
  probe.reports += 1;
  probe.lastReport = report;
  const s = report.snapshot;
  const stateEl = el('state');
  const label: Record<string, string> = {
    warmup: 'Calentando',
    focused: 'Concentrado',
    doubt: '¿Sigues ahí?',
    away: 'No te veo',
    break: 'Descanso · la cámara no vigila',
    paused: 'Pausa',
    ended: 'Terminado',
  };
  stateEl.textContent = label[s.state] ?? s.state;
  stateEl.className = `state ${s.state}`;
  const meter = el('meter');
  meter.className = s.low ? 'meter low' : 'meter';
  (meter.firstElementChild as HTMLElement).style.width = `${s.score ?? 0}%`;
  text('score', s.score === null ? '—' : `${s.score}${s.low ? ' (baja)' : ''}`);
  text('presence', s.presence);
  text('cause', s.cause ?? '—');
  text('doubt-in', secs(s.doubtInMs));
  text('strike-in', secs(s.strikeInMs));
  text('grace', s.graceLeftMs > 0 ? secs(s.graceLeftMs) : '—');
  text('hints', s.hints.length > 0 ? s.hints.join(' · ') : 'ninguno');
  text('classifier', s.classifier ?? (report.mode === 'no-camera' ? 'sin cámara' : '—'));
  const t = report.totals;
  text(
    'totals',
    `${Math.round(t.focusedMs / 1_000)} s concentrado de ${Math.round(t.workMs / 1_000)} s · ${t.warnings} avisos · ${t.strikesRequested} strikes`,
  );
  const loop = report.loop;
  text(
    'fps',
    loop
      ? `${num(loop.fps)} · L${loop.level}${loop.overBudget ? ' (sobre presupuesto)' : ''}`
      : '—',
  );
  text(
    'duty',
    loop ? `${num(loop.duty * 100)} % de un núcleo${loop.throttled ? ' · frenado' : ''}` : '—',
  );
  text('errors', loop ? `${loop.errors} · ${Math.round(loop.maxGapMs)} ms` : '—');
  text(
    'status',
    `${report.mode === 'camera' ? 'Con cámara' : 'Sin cámara'} · cámara ${report.camera}${report.cameraOn ? ' (encendida)' : ''}`,
  );
}

async function startSession(mode: StudyMode): Promise<void> {
  if (session) return;
  await closeCalibration();
  probe.error = null;
  setRunning(true);
  text('status', 'Arrancando…');
  try {
    session = await startStudySessionWith(
      {
        mode,
        settings: settings(),
        profileJson,
        assets: mode === 'camera' ? ASSETS : null,
        initialContext: context(),
        onEvent,
        onReport,
        deps: DEPS,
      },
      PARTS,
    );
    sendContext();
    log(`Sesión ${mode === 'camera' ? 'con cámara' : 'sin cámara'} iniciada`);
  } catch (error) {
    probe.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    text('status', `No se pudo empezar: ${probe.error}`);
    setRunning(false);
  }
}

async function stopSession(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;
  if (contextTimer !== null) clearTimeout(contextTimer);
  contextTimer = null;
  const summary = await current.stop();
  setRunning(false);
  const t = summary.totals;
  text(
    'status',
    `Parado. ${Math.round(t.focusedMs / 1_000)} s concentrado, ${t.warnings} avisos, ${t.strikesRequested} strikes.`,
  );
  log(
    `Resumen: ${summary.timeline.segments.length} tramos, ${summary.timeline.marks.length} marcas`,
  );
}

// ---------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------

const CLASS_LABELS: Record<CalibrationClass, string> = {
  screen: 'Estudiando mirando la pantalla',
  paper: 'Estudiando con libro o cuaderno',
  phone: 'Distraído con el móvil',
  away: 'Mirando a otro lado',
  absent: 'No estoy',
};

let calibration: CalibrationSessionHandle | null = null;
let recording = false;

function renderCalibrationRows(): void {
  const body = el('calibration-rows');
  for (const cls of CALIBRATION_CLASSES) {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = CLASS_LABELS[cls];
    const state = document.createElement('td');
    state.id = `cal-${cls}`;
    state.className = 'muted';
    state.textContent = 'Pendiente';
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = 'Grabar 20 s';
    button.dataset.record = cls;
    button.addEventListener('click', () => void record(cls));
    action.append(button);
    row.append(label, state, action);
    body.append(row);
  }
}

async function closeCalibration(): Promise<void> {
  calibration?.close();
  calibration = null;
}

async function record(cls: CalibrationClass): Promise<void> {
  if (session || recording) return;
  recording = true;
  try {
    calibration ??= await startCalibration({
      assets: ASSETS,
      profileJson,
      onProgress: (progress) => {
        const issues = progress.liveIssues.length > 0 ? ` · ${progress.liveIssues.join(', ')}` : '';
        const phase = progress.phase === 'settling' ? 'Preparado' : 'Grabando';
        text(`cal-${progress.cls}`, `${phase} ${secs(progress.remainingMs)}${issues}`);
      },
      deps: DEPS,
    });
    const summary = await calibration.record(cls);
    const issues = summary.issues.map(
      (i) => `${i.code}${i.severity === 'error' ? ' (error)' : ''}`,
    );
    text(
      `cal-${cls}`,
      `Hecho · ${summary.rows} filas${issues.length > 0 ? ` · ${issues.join(', ')}` : ''}`,
    );
  } catch (error) {
    text(`cal-${cls}`, `Error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recording = false;
  }
}

function build(): void {
  if (!calibration) {
    text('profile', 'Graba primero las situaciones.');
    return;
  }
  const outcome = calibration.build();
  if (!outcome.ok) {
    text(
      'profile',
      `No se pudo construir: ${outcome.issues.map((i) => `${i.code} (${i.cls ?? '—'})`).join(', ')}`,
    );
    return;
  }
  profileJson = outcome.profileJson;
  showProfile();
  const weak = outcome.issues.find((i) => i.code === 'weak_separation');
  log(
    `Perfil construido: precisión CV ${num(outcome.report.cvBinaryBalancedAccuracy * 100)} %${weak?.pair ? ` · confunde ${weak.pair.join('/')}` : ''}`,
  );
}

function showProfile(): void {
  const parsed = profileJson ? parseProfile(profileJson) : null;
  el<HTMLButtonElement>('download').disabled = !parsed?.ok;
  if (!parsed) {
    text('profile', 'Sin perfil: se usa el clasificador genérico.');
  } else if (!parsed.ok) {
    text('profile', `Perfil no válido (${parsed.error}).`);
  } else {
    const p = parsed.profile;
    const feedback = p.samples.src.filter((s) => s === 1).length;
    text(
      'profile',
      `Perfil de ${p.samples.rows.length} filas (${feedback} de «¡Estaba estudiando!») · precisión CV ${num(p.report.cvBinaryBalancedAccuracy * 100)} % · ${Math.round((profileJson?.length ?? 0) / 1_024)} KB`,
    );
  }
}

function download(): void {
  if (!profileJson) return;
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(profileJson)}`;
  link.download = 'profile.json';
  link.click();
}

async function load(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const json = await file.text();
  const parsed = parseProfile(json);
  if (!parsed.ok) {
    text('profile', `Perfil no válido (${parsed.error}).`);
    return;
  }
  profileJson = json;
  await closeCalibration();
  showProfile();
}

// ---------------------------------------------------------------------------------------
// Preview (optional, local only, never analysed)
// ---------------------------------------------------------------------------------------

let previewStream: MediaStream | null = null;

async function togglePreview(): Promise<void> {
  const video = el<HTMLVideoElement>('preview-video');
  if (previewStream) {
    for (const track of previewStream.getTracks()) track.stop();
    previewStream = null;
    video.srcObject = null;
    video.hidden = true;
    return;
  }
  previewStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 320 }, height: { ideal: 240 } },
    audio: false,
  });
  video.srcObject = previewStream;
  video.hidden = false;
  await video.play();
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

renderCalibrationRows();
el('start-camera').addEventListener('click', () => void startSession('camera'));
el('start-no-camera').addEventListener('click', () => void startSession('no-camera'));
el('stop').addEventListener('click', () => void stopSession());
el('feedback').addEventListener('click', () => {
  const outcome = session?.studyingFeedback();
  if (!outcome) return;
  log(
    outcome.ok
      ? `«¡Estaba estudiando!»: ${outcome.added} ejemplos${outcome.doubtCleared ? ', DUDA resuelta' : ''}`
      : `«¡Estaba estudiando!» no aplicado (${outcome.reason})`,
  );
});
el('no-camera').addEventListener('click', () => {
  if (session && !session.continueWithoutCamera()) log('Solo se puede cuando la cámara falla.');
});
el('preview').addEventListener('click', () => void togglePreview());
el('sensitivity').addEventListener('input', () => {
  text('sensitivity-value', el<HTMLInputElement>('sensitivity').value);
  session?.setSettings(settings());
});
el('phase').addEventListener('change', () => session?.setContext(context()));
el('foreground').addEventListener('change', () => session?.setContext(context()));
el('build').addEventListener('click', build);
el('download').addEventListener('click', download);
el<HTMLInputElement>('load').addEventListener('change', (event) => {
  void load(event.target as HTMLInputElement);
});
showProfile();
