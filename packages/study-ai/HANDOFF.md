# @centrate/study-ai: handoff to the desktop team

How to wire the study AI into `apps/desktop`. The package is done on its side: the camera, the
vision pipeline, the classifier, the attention engine, the analysis loop, the session and
calibration facades and the analysis-window host all exist and are tested in Node. What is left
is Electron: a hidden window, a locked-down session, IPC, the heartbeat loop and the UI.

Contract: `src/types.ts` (`AnalysisInbound`, `AnalysisOutbound`, `SessionReport`,
`SessionEvent`, `HeartbeatBody`). Background: `DESIGN.md` §8.3–8.9.

**The one rule behind §3–§4:** once the guardian has accepted `POST /v1/study/sessions`, the
session must never go silent because of something on the app's side (a camera error, a crashed
or hung analysis window, a failed request). Silence for 120 s is abandonment, and the guardian
punishes it. Only a loop that is really dead (killed on purpose, beyond the recreation budget
of §3) may stop the heartbeats.

## 0. Imports and build

| Where                      | Import                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron main              | `@centrate/study-ai` (pure entry: `HeartbeatAccumulator`, `isAnalysisOutbound`, `isAnalysisInbound`, `ANALYSIS_ASSET_SCHEME`, `MODEL_MANIFEST`, `MEDIAPIPE_WASM_FILES`, `resolveStudyAiSettings`, `heartbeatState`, `bucketizeTimeline`, types). Never `parseProfile` (§5) |
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

### 1.0 The analysis window needs WebGL2

MediaPipe tasks-vision 1.0.1 runs both models on the CPU delegate, but it still sends every
frame through WebGL: each task uploads the frame as a texture on a WebGL2 context of its own
1×1 `OffscreenCanvas` and reads it back (`GPU stall due to ReadPixels` in the console is
expected). So:

- **Never call `app.disableHardwareAcceleration()`** and never pass `--disable-gpu` /
  `--disable-webgl` (in production or in the e2e build). Without WebGL the vision pipeline
  cannot start: the session falls back to no-camera mode with `mode{vision_failed}` and the
  `vision_failed` hint. A GPU on Chromium's blocklist does the same (SwiftShader software
  WebGL is only a fallback where Chromium allows it).
- **GPU resets are handled here.** When the GPU process crashes or resets (resume from sleep,
  a driver or TDR reset, a hybrid-GPU switch), both WebGL contexts are lost and MediaPipe
  silently returns empty results. The pipeline watches its task canvases
  (`webglcontextlost`, `isContextLost()`) and throws `VisionLoadError{contextLost: true}`;
  the session then rebuilds the pipeline (about 1 s, measured in the demo smoke test) without
  counting those frames as «no te veo». A rebuild that fails or takes over 8 s, or a second
  loss within 60 s, switches to no-camera mode (`mode{vision_failed}`). `resume` from main
  (below) also rebuilds at once when the context was lost during the suspend.
- Nothing to do in main for this, apart from not disabling the GPU and forwarding
  `powerMonitor` `resume`.

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

let lastCpuSeconds: number | null = null;
let lastCpuAt = 0;

contextBridge.exposeInMainWorld('centrateAnalysis', {
  post: (message: unknown): void => ipcRenderer.send('analysis:out', message),
  onMessage: (listener: (message: unknown) => void): void => {
    ipcRenderer.on('analysis:in', (_event, message: unknown) => listener(message));
  },
  /**
   * CPU used by this renderer since the previous call, in % of ONE core (100 = one core
   * fully busy): the unit of `SessionDeps.cpuProbe` and of the governor's 12 % limit.
   */
  cpuPercent: (): number | null => {
    const usage = process.getCPUUsage(); // sandboxed `process`
    const now = performance.now();
    const cpuSeconds = usage.cumulativeCPUUsage; // CPU seconds since the process started
    if (typeof cpuSeconds !== 'number') {
      // `percentCPUUsage` is a share of the WHOLE machine: scale it back to one core.
      return usage.percentCPUUsage * navigator.hardwareConcurrency;
    }
    const previous = lastCpuSeconds;
    const elapsedMs = now - lastCpuAt;
    lastCpuSeconds = cpuSeconds;
    lastCpuAt = now;
    if (previous === null || elapsedMs <= 0) return null;
    return ((cpuSeconds - previous) * 100_000) / elapsedMs;
  },
});
```

**Units.** Electron divides `percentCPUUsage` by the number of logical cores
(`electron_bindings.cc`: `usagePercent / base::SysInfo::NumberOfProcessors()`), in
`process.getCPUUsage()` and in `app.getAppMetrics()` alike. Passed through unchanged, 30 % of
one core reads as 3.75 % on an 8-core laptop and the governor's measured-CPU guard never fires.
Always convert to % of one core as above; `cumulativeCPUUsage` (CPU seconds) is unambiguous and
does not share its measurement interval with other callers.

### 1.4 The page script (`analysis/main.ts`), complete

```ts
import { ANALYSIS_ASSETS, createAnalysisHost } from '@centrate/study-ai/runtime';

const bridge = window.centrateAnalysis;
const host = createAnalysisHost({
  post: (message) => bridge.post(message),
  assets: ANALYSIS_ASSETS,
  deps: { cpuProbe: () => bridge.cpuPercent() }, // % of one core (§1.3)
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
  reports the camera error as `in_use` or `permission_denied` (the `camera{status: 'error'}`
  event of a session, or `error{camera_failed, camera}` for a calibration recording), show «La
  privacidad de Windows bloquea la cámara» with the steps (Configuración › Privacidad y
  seguridad › Cámara › «Permitir que las aplicaciones de escritorio accedan a la cámara»). The
  package maps `NotReadableError`/`AbortError` to `in_use`; main knows better and should show
  the `blocked_by_system` text instead.
- **Linux:** when the camera error is `not_found` or `permission_denied`, hint that the user
  must be in the `video` group (`/dev/video*`).
- **A camera that never answers** (a wedged driver, macOS `VDCAssistant`, a stuck Windows frame
  server) is given up after 15 s and reported as `unknown`: suggest closing other camera apps or
  replugging it.

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
| `session_start {mode, settings, profileJson, cameraDeviceId, context}` | the guardian accepted `POST /v1/study/sessions` | `event`s + a `report` every second, within 30 s at most (a camera or vision problem starts it without camera, below) |
| `context {context}`                                                    | every 1 s during a session                      | —                                                                                            |
| `settings {settings}`                                                  | the user changed Study Mode settings            | —                                                                                            |
| `strike_result {ack}`                                                  | after each `POST …/strike`                      | —                                                                                            |
| `studying_feedback`                                                    | «¡Estaba estudiando!» clicked                   | `feedback_result {outcome}` (+ `profile_updated`)                                            |
| `continue_without_camera`                                              | «Continuar sin cámara» clicked                  | `event {mode: 'no-camera', reason: 'user'}` if allowed; nothing otherwise                    |
| `resume`                                                               | `powerMonitor` `resume`                         | —                                                                                            |
| `session_stop`                                                         | the session ended (any reason)                  | a last `report`, then `session_stopped {summary}`                                            |
| `calibration_start {profileJson, cameraDeviceId}`                      | the wizard opens                                | `error{vision_failed}` on failure (the camera is not opened yet)                             |
| `calibration_record {cls}`                                             | «Grabar 20 s»                                   | `calibration_progress` ~4 per second, then `calibration_recorded`; `error{camera_failed, camera}` if the camera cannot open |
| `calibration_cancel`                                                   | the user cancels a recording                    | —                                                                                            |
| `calibration_build`                                                    | after the recordings                            | `calibration_built {outcome}`                                                                |
| `calibration_close`                                                    | the wizard closes                               | —                                                                                            |

- One job at a time: a second `session_start`/`calibration_start` gets `error{busy}`. Messages
  sent while a job is still starting are queued and replayed.
- Messages for no job get `error{not_running}`.
- **A study session always starts**, camera or not, because the guardian session already runs:
  - the camera cannot be opened (in use, blocked by the OS, unplugged) or does not answer
    within 15 s → `camera{status: 'error', error}`, then `mode{no-camera}`: the session runs
    without camera. (The mode reason is `vision_failed`, «the camera analysis is unavailable»,
    until the contract gets a `camera_failed` reason; the `camera` event right before it says
    why.) Choosing no-camera mode at start is always allowed, so this is no loophole;
    mid-session camera failures still count as absence until the user picks «Continuar sin
    cámara»;
  - MediaPipe fails to load, or takes over 30 s → `mode{no-camera, vision_failed}` and the
    `vision_failed` hint.
- **Never leave a guardian session without an analysis job.** After `session_start`, reports
  must arrive within ~45 s. If an `error` answers it instead (`busy`: a job was still running,
  so send `session_stop`/`calibration_close` and start again; anything else is a bug), send
  `session_start{mode: 'no-camera'}` at once, or end the guardian session (`POST …/end` is free)
  and tell the user. Do the same if no report arrives within 45 s.
- **A crashed or hung analysis window is recreated.** On `render-process-gone`, or when no
  `report` has arrived for 20 s while a session runs (a hidden window gets no `unresponsive`
  event), `destroy()` it, create a new one and resend `session_start` (same mode, current
  settings, profile and `context`). The accumulator keeps heartbeating the last state for up to
  60 s meanwhile, and the new `runId` restarts its baseline (§4). Recreate at most **2 times per
  session**: after that, stop (heartbeats end within 60 s and the guardian applies its
  abandonment rule). Unlimited recreation would let a user reset the doubt timers by killing
  the renderer.
- Calibration opens the camera only while a situation is being recorded (§6); a camera problem
  answers that `calibration_record` with `error{camera_failed, camera}` and the wizard can try
  again.
- Recording all five situations before `calibration_build` is «Recalibrar» (clean slate, the
  «¡Estaba estudiando!» rows are dropped); recording fewer replaces just those clips. A
  different camera between two recordings discards the earlier clips (`missing` at build).

## 4. Main loop during a session

```ts
const acc = new HeartbeatAccumulator(); // deadAfterMs 60 000
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

/** A guardian answer that settles a request (anything but no response, 408, 429 or 5xx). */
const definitive = (e: unknown): boolean =>
  e instanceof GuardianApiError &&
  e.status >= 400 &&
  e.status < 500 &&
  e.status !== 408 &&
  e.status !== 429;
const notActive = (e: unknown): boolean =>
  e instanceof GuardianApiError && (e.code === 'study_not_active' || e.status === 404);
```

- **Context, every 1 s:** `{ phase, foreground, idleMs }`.
  - `phase`: from the guardian (`GET /v1/study/sessions/current` → `session.phase`, or the
    session carried by any study response). `work | break | paused | ended`.
  - `foreground`: the active-window layer's class of the foreground app or site. During Study
    Mode read the foreground every 1–2 s whether or not a block is active; only the class
    leaves main, never the title.
    - `distraction` = **any catalog service** in front (every catalog category is a distraction
      category), **including `educationalCapable` ones such as YouTube**. PROMPT §8: «si es una
      distracción, no estás estudiando aunque mires la pantalla». As `neutral`, a face at the
      screen scores about 0.9, and the camera path has no idle decay: an hour of entertainment
      video would count as focus.
    - Only exception: if the start card offers «Voy a usar YouTube para estudiar» (a per-session
      opt-in for `educationalCapable` services, off by default, chosen **before** starting and
      never offered mid-session, where it would dodge a doubt), the allowed service reads as
      `neutral`. A catalog service is never on the study whitelist, so the whitelist cannot
      express this.
    - `study` = the study whitelist (catalog defaults + `settings.studyWhitelist`).
    - `neutral` = anything else identified; `unknown` when unsure (unreadable title, macOS
      without Screen Recording).
  - `idleMs`: `powerMonitor.getSystemIdleTime() * 1000`.
  - Context older than 5 s is treated as foreground `unknown` and idle `null` by the window.
- **Heartbeat, every 15 s**, at once after `resume`, and once when the planned end passes. The
  guardian ignores a `seq` ≤ the last accepted one (`duplicate: true`, and the silence is not
  reset), so `seq` must continue the guardian's and a retry must be the identical request:

  ```ts
  // From the start response, or GET …/current when main re-attaches to an active session
  // (app relaunched within the 2 min): never 0 for a session that already has heartbeats.
  let seq = session.lastHeartbeatSeq;
  let pending: HeartbeatRequest | null = null; // sent, not yet answered
  let sending = false;

  async function heartbeat(): Promise<void> {
    if (sending) return; // one request at a time
    if (pending === null) {
      const body = acc.take(performance.now());
      if (body === null) return; // analysis loop dead for > 60 s: stop heartbeating (§10.4)
      pending = { seq: seq + 1, ...body };
    }
    sending = true;
    try {
      const res = await guardian.studyHeartbeat(sessionId, pending);
      // Accepted now, or already (`duplicate`: an earlier try got through): counted once.
      seq = Math.max(pending.seq, res.session.lastHeartbeatSeq);
      pending = null;
      onStudySession(res.session); // phase, status, planned end
    } catch (error) {
      if (notActive(error)) {
        pending = null;
        return sessionEndedElsewhere(); // below
      }
      if (definitive(error)) pending = null; // 400: a bug; log it, never resend it
      // No response, timeout, 5xx: keep `pending` and resend it unchanged (2 s later, then
      // on the 15 s tick). Its deltas were maybe counted already, so never `acc.restore()` it.
    } finally {
      sending = false;
    }
  }
  ```

  `acc.restore(body)` is only for a body that was taken but certainly never sent (the session
  ended before the request went out, say); anything that may have reached the guardian is
  resent identically instead. Killing the analysis window for good (beyond the 2 recreations
  of §3) therefore stops heartbeats within 60 s, and the guardian applies its abandonment
  rule. Never fabricate a heartbeat without a live report.

- **Strike events:** for each `event{type: 'strike', cause, seq}`. The endpoint is idempotent
  with the key `<sessionId>:<runId>:<seq>` (`runId` of the latest report: a run's first strike
  comes after its warm-up, long after its first report), so a failed request is retried with
  the same key and body until the guardian answers:

  ```ts
  async function onStrike(cause: StrikeCause, strikeSeq: number): Promise<void> {
    const idempotencyKey = `${sessionId}:${runId}:${strikeSeq}`;
    const giveUpAt = performance.now() + 5 * 60_000; // idempotency records live 10 min
    let res: StrikeResponse | null = null;
    for (let attempt = 0; res === null; attempt += 1) {
      try {
        res = await guardian.studyStrike(sessionId, { cause }, { idempotencyKey });
      } catch (error) {
        if (notActive(error) || definitive(error) || performance.now() > giveUpAt) return;
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt)); // guardian restarting: retry
      }
    }
    toAnalysis({
      type: 'strike_result',
      ack: {
        seq: strikeSeq,
        counted: res.counted,
        reason: res.reason,
        cooldownLeftMs: res.cooldownUntil
          ? Math.max(0, Date.parse(res.cooldownUntil) - guardianNowMs())
          : null,
      },
    });
    onStudySession(res.session);
    if (res.counted) ui.strike({ cause, pointsDelta: res.pointsDelta }); // §6
    if (res.punishment) ui.punishment(res.punishment); // 3rd counted strike: the session ended
  }
  ```

  `guardianNowMs()` is the guardian's clock as main already tracks it (`serverNow` of the last
  response + elapsed monotonic time). A strike that did not count (`cooldown`,
  `not_in_work_phase`) only updates the grace in the window: no notification, no sound, no
  points. The engine never refunds a strike, and «¡Estaba estudiando!» never asks.

- **Ending («Terminar»)**: settle the heartbeat first, take the last deltas **while the loop is
  still running**, and stop the analysis only once the guardian has answered:

  ```ts
  async function endSession(): Promise<void> {
    await settleHeartbeat(); // resend `pending` (if any) until it is answered, as above
    const body = acc.take(performance.now()); // `null` if the loop is dead
    const request: EndStudyRequest = {
      reason: 'user',
      focusedMsSinceLast: body?.focusedMsSinceLast ?? 0,
      warningsSinceLast: body?.warningsSinceLast ?? 0,
    };
    const idempotencyKey = randomUUID(); // one per «Terminar»: same key AND same body on retries
    for (;;) {
      try {
        const res = await guardian.endStudy(sessionId, request, { idempotencyKey });
        toAnalysis({ type: 'session_stop' }); // now: last report, then session_stopped
        return ui.summary(res.summary); // + the local timeline from session_stopped
      } catch (error) {
        if (definitive(error)) {
          toAnalysis({ type: 'session_stop' }); // 400/404: a bug or an unknown session
          return ui.endFailed(error);
        }
        // Guardian restarting or a transient error: the loop is still running, so the
        // 15 s heartbeats go on (their deltas come after `body`: nothing counts twice).
        // `/end` answers 200 with the stored summary if an earlier try got through.
        await sleep(3_000);
      }
    }
  }
  ```

  This loses at most the ~1 s of focus between `take()` and `session_stop`. Sending
  `session_stop` first would kill the loop: if `/end` then failed, `take()` would return `null`
  60 s later, the heartbeats would stop and «Terminar» would turn into abandonment.
- **The session ended elsewhere** (completed at the planned end, third strike, abandoned,
  interrupted): a heartbeat or `GET …/current` shows `status` ≠ `active`, or a study call
  answers 409 `study_not_active`. Stop heartbeating and retrying, send `session_stop`, and show
  «Resumen» from `GET /v1/study/sessions/{id}` (plus the local timeline).
- **`powerMonitor.on('resume')`** → `resume` message (gap reset: suspended time is never
  punished) and an immediate heartbeat.
- The package already keeps the camera off during breaks («Descanso · la cámara no vigila»):
  after 10 s outside `work`, the track is stopped (`report.cameraOn: false`) and reopened when
  work resumes.

## 5. Persistence

- `event{type: 'profile_updated', profileJson, reason}` (`feedback` or `migrated`) and
  `calibration_built{ok: true, profileJson}` → write `userData/study-ai/profile.json`
  atomically (temp file + rename), debounced ~2 s. It holds numbers only (60–150 KB).
- Write the string **exactly as received**, and only after `isAnalysisOutbound` accepted the
  message: the guard checks that it is the canonical JSON of a strictly valid profile of the
  current format, version and trainer (fixed keys, finite numbers, ISO dates and the camera
  hash, nothing else). So a buggy or compromised analysis renderer cannot make main persist
  anything else (a base64 frame, say) in the file the privacy text describes as calibration
  numbers.
- **Never call `parseProfile` in main.** It retrains a profile of another trainer version,
  which takes seconds of CPU on main's thread; the window does that migration itself and sends
  `profile_updated{migrated}`.
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
| `report.mode` `no-camera`               | same states, header «Sin cámara»      | —          |

`snapshot.score` (0–100, `null` in warm-up and breaks) is the meter width; `graceLeftMs > 0`
is the 60 s after a strike (no new DUDA). `doubtInMs`/`strikeInMs` can drive a subtle countdown.
The header follows `report.mode` (every second, so it is also right after a recreated window).

**«● Cámara activa»** (PROMPT §8: a visible indicator whenever the camera is on):

- during a session it follows `report.cameraOn`;
- in the calibration wizard the window opens the camera only while a situation is recorded
  and stops it when the clip ends, so the pill shows from sending `calibration_record` until
  `calibration_recorded`, an `error{camera_failed}`, or sending `calibration_cancel` /
  `calibration_close`. Never between recordings: the camera is off while the user reads the
  instructions.

**Events:**

| Event                                   | UI                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `warning{kind: 'doubt'}`                | soft sound + «¿Sigues ahí?» + the full-width «¡Estaba estudiando!» button |
| `warning{kind: 'absent'}`               | soft sound + «No te veo» (30 s before the `no_face` strike)               |
| `doubt_cleared`                         | hide the doubt notice                                                     |
| `strike`, the guardian answered `counted: true` | notification + sound + `res.pointsDelta` from the response («−15 puntos», «−115 puntos» on the punishing one; never a hardcoded value); keep «¡Estaba estudiando!» visible; with `res.punishment`, show the punishment and the summary |
| `strike`, `counted: false`              | nothing (cooldown or not in a work phase): `strike_result` only updates the grace |
| `suggest_break{eyes_closed \| yawning}` | gentle «Parece que estás cansado: ¿un descanso?» (never a strike)         |
| `camera{status: 'error', error}`, mid-session (`report.mode` `camera`) | explain the camera error (§2) and offer «Continuar sin cámara» |
| `camera{status: 'error', error}` followed by `mode{no-camera}` (the camera failed at start) | explain the camera error (§2): the session already runs without camera; offer «Seguir sin cámara» (closes the notice) and «Terminar» (free `POST …/end`) |
| `mode{no-camera}`                       | header «Sin cámara» (reason `user`, or `vision_failed` = the camera analysis is unavailable; the `vision_failed` hint or the `camera` event says why) |
| `hint{code, active}`                    | a one-line help text while active (below)                                 |

«¡Estaba estudiando!» → `studying_feedback` → `feedback_result`:
`{ok: true, doubtCleared}` → «Gracias: la IA ha aprendido de este momento» (and the doubt
closes if `doubtCleared`); `{ok: false, reason}`:
`not_calibrated` → «Calibra la cámara para que la IA aprenda de ti»; `limit_reached` → «Ya has
corregido 5 veces en esta sesión»; `no_episode` / `already_used` / `no_usable_frames` → hide
the button; `no_camera` → hide the button (without camera there is nothing to learn from, and
the button is not offered in no-camera mode at all). It never gives points back (the guardian
never refunds a strike).

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
5. **GPU reset:** in the running analysis window, `WEBGL_lose_context.loseContext()` on the
   WebGL contexts (record them with an init script, as `demo/smoke.pw.ts` does): reports keep
   `mode: 'camera'`, `loop.errors` stays 0 and frames are analysed again within a few seconds.
6. **Permissions:** `media` with audio is denied; any other webContents is denied.

`packages/study-ai` already covers the browser side in `npm run test:browser -w
packages/study-ai` (real WASM and models in Chromium with a fake camera: ≥ 2 fps, finite
features, the logger's POST refused by the CSP).
