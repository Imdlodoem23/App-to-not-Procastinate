# @centrate/study-ai: handoff to the desktop team

How to wire the study AI into `apps/desktop`. The package is done on its side: the camera, the
vision pipeline, the classifier, the attention engine, the analysis loop, the session and
calibration facades and the analysis-window host all exist and are tested in Node. What is left
is Electron: a hidden window, a locked-down session, IPC, the heartbeat loop and the UI.

Contract: `src/types.ts` (`AnalysisInbound`, `AnalysisOutbound`, `SessionReport`,
`SessionEvent`, `HeartbeatBody`). Background: `DESIGN.md` §8.3–8.9.

## 0. Imports and build

| Where                      | Import                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron main              | `@centrate/study-ai` (pure entry: `HeartbeatAccumulator`, `isAnalysisOutbound`, `isAnalysisInbound`, `ANALYSIS_ASSET_SCHEME`, `MODEL_MANIFEST`, `MEDIAPIPE_WASM_FILES`, `resolveStudyAiSettings`, `heartbeatState`, `bucketizeTimeline`, types) |
| The hidden analysis window | `@centrate/study-ai/runtime` (`createAnalysisHost`, `ANALYSIS_ASSETS`)                                                                                                                                                                          |
| Never                      | `@centrate/study-ai/runtime` from main or preload (it pulls in DOM code and MediaPipe)                                                                                                                                                          |

- The package ships TypeScript source (`exports` → `src/*.ts`), like `@centrate/shared`. Add it
  to `apps/desktop/package.json` (`"@centrate/study-ai": "*"`) and to the
  `externalizeDepsPlugin({ exclude: [...] })` lists in `electron.vite.config.ts` so it is
  bundled, not `require`d at runtime.
- The analysis window is one more renderer entry of electron-vite (for example
  `src/renderer/analysis.html` + `src/renderer/analysis/main.ts`) with its own tiny preload.
  MediaPipe is loaded with a dynamic `import()` inside the vision loader, so Vite emits it as a
  separate chunk of that entry only.
- `npm run fetch-models -w packages/study-ai` must run before `electron-builder` (the `dist`
  script and the release workflow): it verifies the two committed models and copies the SIMD
  WASM pair from `node_modules/@mediapipe/tasks-vision/wasm/` into
  `apps/desktop/resources/models/mediapipe/` (git-ignored, SHA-256 checked). With the models
  already committed it downloads nothing. `-- --check` only verifies.
- `electron-builder.yml` → `extraResources`:

  ```yaml
  - from: resources/models
    to: models
    filter:
      [
        '*.task',
        '*.tflite',
        'manifest.json',
        'mediapipe/vision_wasm_internal.js',
        'mediapipe/vision_wasm_internal.wasm',
      ]
  ```

## 1. The hidden analysis window

One window per app run, created when Study Mode (or the calibration wizard) starts and closed
when it ends.

```ts
const ANALYSIS_PARTITION = 'centrate-ai'; // not "persist:": nothing is written to disk

const analysis = new BrowserWindow({
  show: false,
  width: 320,
  height: 240,
  webPreferences: {
    partition: ANALYSIS_PARTITION,
    preload: join(__dirname, '../preload/analysis.js'),
    backgroundThrottling: false, // the loop must keep 2–4 fps while hidden
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  },
});
analysis.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
analysis.webContents.on('will-navigate', (event) => event.preventDefault());
analysis.webContents.on('will-redirect', (event) => event.preventDefault());
await analysis.loadFile(join(__dirname, '../renderer/analysis.html')); // from the app bundle
```

- **Never `show()` it**, and never load anything else in it. The visible wizard shows its own
  `getUserMedia` preview (320×240, hidden by default); frames never cross IPC.
- In dev (`electron-vite dev`) the page comes from the Vite dev server: allow exactly that
  loopback origin in the request filter below, nothing else.

### 1.1 Locked-down session (no network at all)

MediaPipe's bundle POSTs usage statistics to `odml.pa.googleapis.com` every 60 s and on
close, and it cannot be switched off (DESIGN.md §5.2). The analysis window therefore has no
network. Do all of this **before** creating the window:

```ts
// Before app 'ready' (module top level of main):
protocol.registerSchemesAsPrivileged([
  {
    scheme: ANALYSIS_ASSET_SCHEME, // 'centrate-ai'
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// After 'ready':
const ses = session.fromPartition(ANALYSIS_PARTITION);
ses.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (_details, callback) => callback({ cancel: true }), // dev: let the dev-server origin through
);
ses.setPermissionRequestHandler((wc, permission, callback, details) => {
  const videoOnly =
    permission === 'media' &&
    Array.isArray(details.mediaTypes) &&
    details.mediaTypes.length > 0 &&
    details.mediaTypes.every((t) => t === 'video');
  callback(videoOnly && wc === analysis.webContents);
});
ses.setPermissionCheckHandler(
  (wc, permission) => permission === 'media' && wc === analysis?.webContents,
);
ses.setDevicePermissionHandler(() => false);
ses.on('will-download', (event) => event.preventDefault());
```

CSP of `analysis.html` (meta tag and, for dev, a response header):

```text
default-src 'none'; script-src 'self' centrate-ai: 'wasm-unsafe-eval';
connect-src centrate-ai:; img-src 'none'; media-src mediastream: blob:;
style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

When the logger's POST fails, MediaPipe clears its own interval, so it stops after one
attempt. `test/guards.test.ts` fails if a MediaPipe upgrade adds another host.

### 1.2 The `centrate-ai://` asset protocol

Serve **only** these paths, from `process.resourcesPath/models` (packaged) or
`apps/desktop/resources/models` (dev):

| URL                                                                    | File                                         | Content-Type               |
| ---------------------------------------------------------------------- | -------------------------------------------- | -------------------------- |
| `centrate-ai://assets/mediapipe/vision_wasm_internal.js`               | `models/mediapipe/vision_wasm_internal.js`   | `text/javascript`          |
| `centrate-ai://assets/mediapipe/vision_wasm_internal.wasm`             | `models/mediapipe/vision_wasm_internal.wasm` | `application/wasm`         |
| `centrate-ai://assets/models/<file>` for each `MODEL_MANIFEST[i].file` | `models/<file>`                              | `application/octet-stream` |

```ts
const ALLOWED = new Map<string, string>([
  ...MEDIAPIPE_WASM_FILES.map((f) => [`/mediapipe/${f}`, join(modelsRoot, 'mediapipe', f)]),
  ...MODEL_MANIFEST.map((m) => [`/models/${m.file}`, join(modelsRoot, m.file)]),
]);
ses.protocol.handle(ANALYSIS_ASSET_SCHEME, async (request) => {
  const url = new URL(request.url);
  const file = url.hostname === 'assets' ? ALLOWED.get(url.pathname) : undefined;
  if (request.method !== 'GET' || file === undefined) return new Response(null, { status: 404 });
  return new Response(await readFile(file), {
    headers: {
      'content-type': contentTypeFor(file),
      'access-control-allow-origin': '*', // MediaPipe injects <script crossorigin="anonymous">
      'cache-control': 'no-store',
    },
  });
});
```

A fixed map means no path traversal is possible. The vision loader checks every model's size
and SHA-256 against `MODEL_MANIFEST` anyway (`VisionLoadError('hash_mismatch')`).

### 1.3 Preload of the analysis window

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('centrateAnalysis', {
  post: (message: unknown): void => ipcRenderer.send('analysis:out', message),
  onMessage: (listener: (message: unknown) => void): void => {
    ipcRenderer.on('analysis:in', (_event, message: unknown) => listener(message));
  },
  /** % of one core used by this renderer since the previous call (sandboxed `process`). */
  cpuPercent: (): number => process.getCPUUsage().percentCPUUsage,
});
```

### 1.4 The page script (`analysis/main.ts`), complete

```ts
import { ANALYSIS_ASSETS, createAnalysisHost } from '@centrate/study-ai/runtime';

const bridge = window.centrateAnalysis;
const host = createAnalysisHost({
  post: (message) => bridge.post(message),
  assets: ANALYSIS_ASSETS,
  deps: { cpuProbe: () => bridge.cpuPercent() },
});
bridge.onMessage((message) => host.handle(message));
window.addEventListener('pagehide', () => void host.dispose());
```

## 2. Camera permission

- **macOS:** `NSCameraUsageDescription` is already in `electron-builder.yml` (`mac.extendInfo`).
  Check `systemPreferences.getMediaAccessStatus('camera')`; call
  `systemPreferences.askForMediaAccess('camera')` **only after** the first-run consent screen
  («Ninguna imagen sale de tu ordenador»). `denied`/`restricted` → explain System Settings ›
  Privacy & Security › Camera and offer «Sin cámara».
- **Windows:** before starting a camera session, read
  `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam`
  and the same key under `HKLM`, plus the `NonPackaged` subkey of each (`Value` = `Deny` means
  blocked). Use a constant `reg query` argv through the existing `src/main/system/exec.ts`
  helper (never with received data) or a native read. When blocked, and the analysis window
  reports `error{camera_failed, camera: 'in_use' | 'permission_denied'}`, show «La privacidad de
  Windows bloquea la cámara» with the steps (Configuración › Privacidad y seguridad › Cámara ›
  «Permitir que las aplicaciones de escritorio accedan a la cámara»). The package maps
  `NotReadableError`/`AbortError` to `in_use`; main knows better and should show the
  `blocked_by_system` text instead.
- **Linux:** when `camera_failed` is `not_found` or `permission_denied`, hint that the user must
  be in the `video` group (`/dev/video*`).

## 3. IPC

Validate on **both** sides; drop anything that fails.

```ts
// main → analysis window
function toAnalysis(message: AnalysisInbound): void {
  if (!isAnalysisInbound(message)) throw new Error('bug: invalid inbound message');
  analysis?.webContents.send('analysis:in', message);
}

// analysis window → main
ipcMain.on('analysis:out', (event, message: unknown) => {
  if (event.sender !== analysis?.webContents) return; // only the analysis window
  if (!isAnalysisOutbound(message)) return log.warn('study-ai: invalid message dropped');
  onAnalysisMessage(message);
});
```

| main sends                                                             | when                                            | the window answers                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `session_start {mode, settings, profileJson, cameraDeviceId, context}` | the guardian accepted `POST /v1/study/sessions` | `event`s + a `report` every second; `error{camera_failed, camera}` if the camera cannot open |
| `context {context}`                                                    | every 1 s during a session                      | —                                                                                            |
| `settings {settings}`                                                  | the user changed Study Mode settings            | —                                                                                            |
| `strike_result {ack}`                                                  | after each `POST …/strike`                      | —                                                                                            |
| `studying_feedback`                                                    | «¡Estaba estudiando!» clicked                   | `feedback_result {outcome}` (+ `profile_updated`)                                            |
| `continue_without_camera`                                              | «Continuar sin cámara» clicked                  | `event {mode: 'no-camera', reason: 'user'}` if allowed; nothing otherwise                    |
| `resume`                                                               | `powerMonitor` `resume`                         | —                                                                                            |
| `session_stop`                                                         | the session ended (any reason)                  | a last `report`, then `session_stopped {summary}`                                            |
| `calibration_start {profileJson, cameraDeviceId}`                      | the wizard opens                                | `error{camera_failed \| vision_failed}` on failure                                           |
| `calibration_record {cls}`                                             | «Grabar 20 s»                                   | `calibration_progress` ~4 per second, then `calibration_recorded`                            |
| `calibration_cancel`                                                   | the user cancels a recording                    | —                                                                                            |
| `calibration_build`                                                    | after the recordings                            | `calibration_built {outcome}`                                                                |
| `calibration_close`                                                    | the wizard closes                               | —                                                                                            |

- One job at a time: a second `session_start`/`calibration_start` gets `error{busy}`. Messages
  sent while a job is still starting are queued and replayed.
- Messages for no job get `error{not_running}`.
- A vision (MediaPipe) failure at session start is **not** an error: the session continues in
  no-camera mode and emits `mode{no-camera, vision_failed}` and the `vision_failed` hint.
- Recording all five situations before `calibration_build` is «Recalibrar» (clean slate, the
  «¡Estaba estudiando!» rows are dropped); recording fewer replaces just those clips.

## 4. Main loop during a session

```ts
const acc = new HeartbeatAccumulator(); // deadAfterMs 60 000
let seq = 0;
let runId: string | null = null;

function onAnalysisMessage(m: AnalysisOutbound): void {
  switch (m.type) {
    case 'report':
      runId = m.report.runId;
      acc.report(m.report, performance.now());
      ui.studyMeter(m.report); // snapshot → meter, see §6
      break;
    case 'event':
      handleEvent(m.event);
      break;
    // feedback_result, session_stopped, calibration_* → UI
  }
}
```

- **Context, every 1 s:** `{ phase, foreground, idleMs }`.
  - `phase`: from the guardian (`GET /v1/study/sessions/current` → `session.phase`, or the
    session carried by any study response). `work | break | paused | ended`.
  - `foreground`: the active-window layer's classification of the foreground app or site:
    `distraction` = a catalog category that is not `educationalCapable`; `study` = the study
    whitelist; `neutral` = anything else known; `unknown` when unsure.
  - `idleMs`: `powerMonitor.getSystemIdleTime() * 1000`.
  - Context older than 5 s is treated as foreground `unknown` and idle `null` by the window.
- **Heartbeat, every 15 s**, at once after `resume`, and once when the planned end passes:

  ```ts
  const body = acc.take(performance.now());
  if (body === null) return; // analysis loop dead for > 60 s: stop heartbeating (§10.4)
  try {
    await guardian.studyHeartbeat(sessionId, { seq: ++seq, ...body });
  } catch {
    acc.restore(body); // network/guardian hiccup: the deltas go with the next one
  }
  ```

  Killing the analysis window therefore stops heartbeats within 60 s, and the guardian applies
  its abandonment rule. Never fabricate a heartbeat without a live report.

- **Strike events:** for each `event{type: 'strike', cause, seq}`:

  ```ts
  const res = await guardian.studyStrike(
    sessionId,
    { cause },
    {
      idempotencyKey: `${sessionId}:${runId}:${seq}`,
    },
  );
  toAnalysis({
    type: 'strike_result',
    ack: {
      seq,
      counted: res.counted,
      reason: res.reason,
      cooldownLeftMs: res.cooldownUntil
        ? Math.max(0, Date.parse(res.cooldownUntil) - guardianNowMs())
        : null,
    },
  });
  ```

  `guardianNowMs()` is the guardian's clock as main already tracks it (`serverNow` of the last
  response + elapsed monotonic time). The third counted strike returns the punishment: show it
  and stop the session. The engine never refunds a strike, and «¡Estaba estudiando!» never asks.

- **Ending:** `POST …/end` with the last deltas: send `session_stop`, wait for the final
  `report` (it comes right before `session_stopped`), then `acc.take(now)` gives
  `focusedMsSinceLast`/`warningsSinceLast` for the end request.
- **`powerMonitor.on('resume')`** → `resume` message (gap reset: suspended time is never
  punished) and an immediate heartbeat.
- The package already keeps the camera off during breaks («Descanso · la cámara no vigila»):
  after 10 s outside `work`, the track is stopped (`report.cameraOn: false`) and reopened when
  work resumes.

## 5. Persistence

- `event{type: 'profile_updated', profileJson, reason}` (`feedback` or `migrated`) and
  `calibration_built{ok: true, profileJson}` → write `userData/study-ai/profile.json`
  atomically (temp file + rename), debounced ~2 s. It holds numbers only (60–150 KB).
- Pass its content as `profileJson` in `session_start`/`calibration_start` (`null` when absent).
  An unreadable profile is ignored by the window (generic classifier + `recalibrate` hint).
- «Borrar todos mis datos» deletes `userData/study-ai/` (with the rest of the local data).
- The window never stores anything: its partition is in-memory and the package bans storage
  APIs (guard test).

## 6. UI mapping

**Meter** (6 px, always with text) from `report.snapshot` + `report.mode`:

| Snapshot                                | Text                                  | Color      |
| --------------------------------------- | ------------------------------------- | ---------- |
| `state` `warmup` / `focused`, not `low` | «Concentrado»                         | `--green`  |
| `focused` and `low`                     | «Concentrado» (meter falling)         | `--orange` |
| `doubt`                                 | «¿Sigues ahí?»                        | `--orange` |
| `away`                                  | «No te veo»                           | `--red`    |
| `break`                                 | «Descanso 4:12 · la cámara no vigila» | grey       |
| `paused`                                | «Pausa 3:40»                          | grey       |
| `mode: 'no-camera'`                     | same states, header «Sin cámara»      | —          |

`snapshot.score` (0–100, `null` in warm-up and breaks) is the meter width; `graceLeftMs > 0`
is the 60 s after a strike (no new DUDA). `doubtInMs`/`strikeInMs` can drive a subtle countdown.
The «● Cámara activa» pill follows `report.cameraOn`.

**Events:**

| Event                                   | UI                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `warning{kind: 'doubt'}`                | soft sound + «¿Sigues ahí?» + the full-width «¡Estaba estudiando!» button |
| `warning{kind: 'absent'}`               | soft sound + «No te veo» (30 s before the `no_face` strike)               |
| `doubt_cleared`                         | hide the doubt notice                                                     |
| `strike` (after the guardian answered)  | notification + sound + «−15 puntos»; keep «¡Estaba estudiando!» visible   |
| `suggest_break{eyes_closed \| yawning}` | gentle «Parece que estás cansado: ¿un descanso?» (never a strike)         |
| `camera{status: 'error', error}`        | explain the camera error and offer «Continuar sin cámara»                 |
| `mode{no-camera}`                       | header «Sin cámara»                                                       |
| `hint{code, active}`                    | a one-line help text while active (below)                                 |

«¡Estaba estudiando!» → `studying_feedback` → `feedback_result`:
`{ok: true, doubtCleared}` → «Gracias: la IA ha aprendido de este momento» (and the doubt
closes if `doubtCleared`); `{ok: false, reason}`:
`not_calibrated` → «Calibra la cámara para que la IA aprenda de ti»; `limit_reached` → «Ya has
corregido 5 veces en esta sesión»; `no_episode` / `already_used` / `no_usable_frames` → hide
the button. It never gives points back (the guardian never refunds a strike).

**Hints** (codes only; the strings are the desktop's, suggestions):

| Code                  | Suggested text                                                         |
| --------------------- | ---------------------------------------------------------------------- |
| `low_light`           | «Hay poca luz: enciende una lámpara para que la cámara te vea».        |
| `camera_covered`      | «La cámara está tapada: cuenta como que no estás».                     |
| `camera_cant_see_you` | «La cámara no te ve bien: colócala de frente».                         |
| `camera_lost`         | «La cámara no responde».                                               |
| `recalibrate`         | «Recalibra para que la IA te conozca con esta cámara».                 |
| `over_budget`         | «Tu ordenador va justo: la IA analiza menos fotogramas».               |
| `throttled`           | «El análisis va lento: no cierres Céntrate a la fuerza».               |
| `vision_failed`       | «La IA de la cámara no ha podido arrancar: sigues en modo sin cámara». |

**Resumen:** `session_stopped.summary.timeline` → `bucketizeTimeline(timeline, n)` for the
full-width line (distractions in orange and red); totals from the guardian's `StudySummary`.

**Calibration window:** rows «Pendiente → Grabando 12 s → Hecho» from `calibration_progress`
(`phase`, `remainingMs`, `liveIssues` such as `no_face` to say «no te veo» early) and
`calibration_recorded.summary.issues`; after `calibration_built`, `issues` with
`weak_separation` (`pair`) → «La IA confunde el móvil con mirar a otro lado: repite esas dos».

## 7. Tests the desktop must add

1. **Hidden window e2e** (Playwright for Electron, `xvfb-run -a`, Chromium fake camera via
   `app.commandLine.appendSwitch('use-fake-device-for-media-stream')` in a test build):
   window hidden for 5 minutes, reports keep coming with `loop.fps ≥ 2`; sample
   `app.getAppMetrics()` for the analysis window's pid and assert its CPU stays under 15 %
   (on the CI runner, with a tolerance note).
2. **Dead loop:** kill the analysis renderer (`analysis.webContents.forcefullyCrashRenderer()`);
   heartbeats stop within 60 s (`HeartbeatAccumulator.take` returns `null`).
3. **No network:** with the analysis window running, no http(s)/ws(s) request from its
   session succeeds (spy `onBeforeRequest`, which cancels them all). After `session_stop` the
   MediaPipe logger tries `odml.pa.googleapis.com`: it must show up as a CSP violation
   (`securitypolicyviolation`) or a cancelled request, never as a response.
4. **Protocol:** `centrate-ai://assets/../x`, unknown files and non-GET methods return 404.
5. **Permissions:** `media` with audio is denied; any other webContents is denied.

`packages/study-ai` already covers the browser side in `npm run test:browser -w
packages/study-ai` (real WASM and models in Chromium with a fake camera: ≥ 2 fps, finite
features, the logger's POST refused by the CSP).
