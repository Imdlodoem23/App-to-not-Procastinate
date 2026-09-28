# @centrate/study-ai: final design

Status: merged from proposals A and B by the lead on 2026-09-28. The contract is
`src/types.ts`. Every public function already exists as a typed stub that throws
`not implemented: <name>`. Builders replace the stubs and keep their signatures.

Sources: PROMPT.md §8 and the Study Mode parts of §10, docs/ARCHITECTURE.md §10.4–§10.5,
and `STUDY_RULES` in `packages/shared/src/points.ts`.

## 1. Scope

This package decides **when** the app reports doubt, strikes and focus to the guardian,
and computes the focus score. It does nothing else.

**The guardian is the authority for:**

- phases (work, break, paused, ended);
- whether a strike counts (cooldown, work phase);
- points, the third strike, punishments;
- abandonment (heartbeat silence) and the pause quota (2 × 5 min per hour).

The package never talks to the guardian itself.

**It produces:**

- `AttentionEvent`s, sent at once: `warning`, `strike` requests, `suggest_break`, `hint`s, state changes;
- a `SessionReport` at 1 Hz: a snapshot plus **cumulative** totals;
- a local `SessionTimeline` of numbers for «Resumen»;
- a `CalibrationProfile` JSON of numbers that main persists.

Electron main turns reports into the 15 s heartbeats (`HeartbeatAccumulator`) and POSTs
`/strike` for each `strike` event.

**Where it runs:** in a hidden renderer window (the "analysis window") and in Node for the
tests. It has **no Electron imports**.

## 2. Hard requirements and where they are met

| Brief requirement                                                           | Mechanism                                                                                                                                                                             | Owner                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 2–4 fps, low resolution                                                     | 320×240 capture; loop levels between 250 and 500 ms; floor of 2 fps                                                                                                                   | PERCEPTION, RUNTIME         |
| setTimeout loop, never rAF; keeps running with the window hidden            | `AdaptiveLoop` on injected `TimerApi`; `ImageCapture.grabFrame()` does not depend on rendering; hidden window with `backgroundThrottling:false`; a guard test bans rAF and rVFC       | RUNTIME                     |
| CPU under 15 %                                                              | `CpuGovernor`: duty target 0.08 of one core, optional process-CPU probe at 12 %, adapts fps and detector rate; `AdaptiveLoop`: hard duty cap of 0.15 of one core (never a busy loop)  | RUNTIME                     |
| No image stored or leaving the process                                      | Only `FrameFeatures` numbers leave the vision pipeline; frames are closed in `finally`; guard tests ban storage, network and image-export APIs; MediaPipe telemetry is blocked (§5.2) | all                         |
| Looking down to write or read is studying                                   | Looking-down floor (§7.3) and the `paper` calibration class; only a visible phone in hand overrides it                                                                                | DECISION, LEARNING          |
| Phone in hand weighs heavily                                                | `phoneCap` 0.10 overrides every floor; persistent `E_phone` names the strike cause                                                                                                    | DECISION, PERCEPTION        |
| Book is positive                                                            | Book evidence raises the score to the study floor and never lowers it                                                                                                                 | DECISION                    |
| Eyes closed for long → suggest a break, not a strike                        | Drowsy frames stay out of the window, timers freeze, `suggest_break` at most every 10 min                                                                                             | DECISION                    |
| No-camera mode                                                              | `NoCameraObserver`: foreground class plus keyboard/mouse idle time only                                                                                                               | RUNTIME                     |
| Score 0–100 smoothed over 10–20 s, with hysteresis                          | Time-weighted window W (default 15 s), H = 8, fast recovery on a 3 s window                                                                                                           | DECISION                    |
| ENFOCADO → 15 s → DUDA → 30 s → STRIKE; 60 s grace                          | State machine (§7.6); grace = `STUDY_RULES.strikeCooldownMs`                                                                                                                          | DECISION                    |
| No face for 60 s → strike, except in breaks                                 | Absence accumulator; covered and camera-lost count as absent (fail closed)                                                                                                            | DECISION                    |
| Pomodoro breaks and Pausa don't count                                       | Phase ≠ work → `break`/`paused`: everything reset, camera off after 10 s                                                                                                              | DECISION, RUNTIME           |
| Covering the camera = not there                                             | Luma `covered` → presence `covered` → absent, whatever the input activity                                                                                                             | PERCEPTION, DECISION        |
| Configurable timings and sensitivity                                        | `resolveStudyAiSettings` clamps to `STUDY_RULES` plus two local ranges                                                                                                                | lead                        |
| Personal classifier trained locally on 5 situations of ~20 s, recalibration | `CalibrationRecorder` → `buildProfile` (softmax, CV) → `profile.json`                                                                                                                 | LEARNING, RUNTIME           |
| «¡Estaba estudiando!» adds examples and retrains, never refunds a strike    | engine episode → `learnFromFeedback` → classifier swap → rescore                                                                                                                      | DECISION, LEARNING, RUNTIME |

## 3. Architecture

```text
 camera ──► PERCEPTION ──FrameFeatures──► DECISION.CameraObserver ──Observation──► DECISION.AttentionEngine
 (320×240)  MediaPipe + extractor          ▲ uses LEARNING.AttentionClassifier          smoothing, hysteresis,
                                           │                                            state machine, totals,
 main: phase, foreground, idle ─ContextInput┤                                           timeline, feedback ring
                                           │                                                   │
                          RUNTIME.NoCameraObserver (no-camera mode) ──Observation──────────────┘
                                                                                               ▼
 RUNTIME: AdaptiveLoop + CpuGovernor + session facade + analysis host ──events / 1 Hz reports──► main (IPC)
 main: HeartbeatAccumulator ─► POST …/heartbeat every 15 s · POST …/strike on each strike event
```

### Entry points

| Import                       | File             | Contents                                                                                                                                                 | Constraint                                                                                                             |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@centrate/study-ai`         | `src/index.ts`   | types, settings, assets constants, extractor, classifiers, calibration and profile, observers, engine, governor, loop, heartbeat accumulator, IPC guards | DOM-free, Node-safe. `tsconfig.pure.json` typechecks it with `lib: ["ES2023"]` only, because Electron main imports it. |
| `@centrate/study-ai/runtime` | `src/runtime.ts` | everything above, plus `openCamera`, `createVisionPipeline`, `startStudySession`, `startCalibration`, `createAnalysisHost`                               | Renderer only. MediaPipe is loaded with a dynamic `import()` inside `createVisionPipeline`.                            |

Browser-only files (the guard test list): `src/runtime.ts`, `src/perception/vision.ts`,
`src/perception/camera.ts`, `src/runtime/session.ts`, `src/runtime/calibration-session.ts`,
`src/runtime/analysis-host.ts`, and anything under `src/perception/browser/`. Put new
DOM-dependent perception code under `src/perception/browser/`.

### Layering

A folder imports only from its own layer or a lower one (enforced by `test/guards.test.ts`):

| Layer | Folders                             |
| ----- | ----------------------------------- |
| 0     | `types`, `config`, `util`, `assets` |
| 1     | `perception`                        |
| 2     | `classifier`, `calibration`         |
| 3     | `score`, `state`                    |
| 4     | `runtime`                           |

From `@centrate/shared`, import only `@centrate/shared/points` and `@centrate/shared/domain`
(type-only for domain). Never import the root, which pulls in the catalog and the parser.

### Privacy and determinism guards (`test/guards.test.ts`)

**Never allowed:**

- `electron`
- `requestAnimationFrame` / `requestVideoFrameCallback`
- `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`
- `localStorage`, `sessionStorage`, `indexedDB`
- `toDataURL`, `toBlob`, `convertToBlob`, `createObjectURL`
- `Math.random` (use `src/util/rng.ts`)

**Allowed in one place only:**

| API                                             | Only in                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `fetch(`                                        | `src/perception/vision.ts` (local model URLs)       |
| `getImageData`                                  | `src/perception/**`                                 |
| `Date.now()`, `performance.now()`, `new Date()` | `src/perception`, `src/runtime`, `src/util/time.ts` |
| `@mediapipe/tasks-vision` value import          | dynamic `import()` in `vision.ts`                   |

All other time comes from inputs. A test also checks that the MediaPipe bundle contains
no network host other than `MEDIAPIPE_NETWORK_HOSTS`.

## 4. Ownership and working rules

| Builder                                            | Writes                                                                                                                                                                                                                                                                      | Implements (public)                                                                                                                                                                                                    | Tests                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Lead** (frozen now; changes via the coordinator) | `src/types.ts`, `src/index.ts`, `src/runtime.ts`, `src/config.ts`, `src/util/**`, `package.json`, `tsconfig*.json`, `DESIGN.md`, `README.md`, `test/guards.test.ts`, `test/foundation.test.ts`, `test/contracts.test.ts`, `test/helpers/**`, `/ASSET-LICENSES.json` entries | settings, utilities, clock/timers                                                                                                                                                                                      | as listed                                   |
| **PERCEPTION**                                     | `src/perception/**`, `src/assets.ts` (pre-filled), `scripts/fetch-models.mjs`, `apps/desktop/resources/models/**`                                                                                                                                                           | `poseFromMatrix`, `FeatureExtractor`, `createVisionPipeline`, `VisionLoadError`, `openCamera`, `listCameras`, `CameraOpenError`                                                                                        | `test/perception/**`                        |
| **LEARNING**                                       | `src/classifier/**`, `src/calibration/**`                                                                                                                                                                                                                                   | `frameToRow`, `createPersonalClassifier`, `createGenericClassifier`, `CalibrationRecorder`, `buildProfile`, `serializeProfile`, `parseProfile`, `profileMatchesCamera`, `learnFromFeedback`, `PROFILE_TRAINER_VERSION` | `test/classifier/**`, `test/calibration/**` |
| **DECISION**                                       | `src/score/**`, `src/state/**`, `test/synth/**`                                                                                                                                                                                                                             | `CameraObserver`, `AttentionEngine`, `heartbeatState`, `strikeCauseFor`, `bucketizeTimeline`                                                                                                                           | `test/score/**`, `test/state/**`            |
| **RUNTIME**                                        | `src/runtime/**`, `demo/**`, `HANDOFF.md`                                                                                                                                                                                                                                   | `NoCameraObserver`, `CpuGovernor`, `LOOP_LEVELS`, `AdaptiveLoop`, `HeartbeatAccumulator`, `isAnalysisInbound`, `isAnalysisOutbound`, `startStudySession`, `startCalibration`, `createAnalysisHost`                     | `test/runtime/**`, `test/acceptance/**`     |

**Rules:**

- Write only inside your paths. Other builders' files and `test/synth` are read-only for you. Ask the coordinator for changes; if you only need a fixture, add it to your own test folder.
- Keep every exported name and signature from the stubs. You may add internal files and exports in your own folder. Public additions must go through the coordinator; only optional fields may be added to `types.ts`.
- Module-internal thresholds go in a `constants.ts` inside your folder, with the starting values below. Cross-module constants live in `STUDY_AI_CONSTANTS` (`src/config.ts`).
- **Tests stay green while the others work.** A test that needs another builder's module wraps itself in `describe.runIf(implemented(() => …))` (`test/helpers/implemented.ts`). Unit tests use fakes of the other modules instead: an oracle `AttentionClassifier`, a fake `VisionPipeline` that replays synth `FrameFeatures`, a fake `FrameSource`.
- No npm installs. `vite`, `vitest` and `@playwright/test` are already hoisted at the repo root.
- Before you finish, all of these must pass:
  - `npm run typecheck -w packages/study-ai` (both tsconfigs)
  - `npx eslint packages/study-ai`
  - `npm test -w packages/study-ai`
  - `npx prettier --write` on your files

## 5. PERCEPTION

### 5.1 Assets and offline loading

**Models** are committed in `apps/desktop/resources/models/`, next to a `manifest.json` that
mirrors `MODEL_MANIFEST` (`src/assets.ts`):

| File                                       | Bytes     | SHA-256                                                            |
| ------------------------------------------ | --------- | ------------------------------------------------------------------ |
| `face_landmarker.task` (float16 v1)        | 3 758 596 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| `efficientdet_lite0_int8.tflite` (int8 v1) | 4 602 795 | `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb` |

- The float16 EfficientDet (7 254 339 B) is not shipped.
- Verified copies are already in the session scratchpad (`…/scratchpad/face_landmarker.task`, `…/efficientdet_lite0_int8.tflite`).
- `scripts/fetch-models.mjs` has three modes:
  - default: download from the pinned URLs;
  - `--from <dir>`: copy local files;
  - `--check`: verify only.
- Every mode verifies size and SHA-256, writes atomically, and never runs at app runtime.
- `test/perception/models.test.ts` checks the committed files against the manifest.

**WASM:**

- Only the SIMD pair `vision_wasm_internal.{js,wasm}` from `@mediapipe/tasks-vision` 1.0.1 (pinned exactly) is used.
- The desktop build copies it (about 12 MB); it is not committed. See HANDOFF.
- `FilesetResolver.forVisionTasks(wasmBaseUrl)` builds `${base}/vision_wasm_internal.*` and injects `<script crossorigin="anonymous">`. It therefore needs a served URL: `file://` fetch is unreliable.

**Loading (`createVisionPipeline`):**

1. Check `isAllowedAssetUrl` for every URL. Only `centrate-ai://assets/…` and loopback http(s) (dev, demo) are allowed; anything else → `VisionLoadError('asset_rejected')`.
2. If `FilesetResolver.isSimdSupported()` is false → `simd_unsupported`.
3. `fetch` each model URL (or take `{bytes}`), check SHA-256 against `MODEL_MANIFEST` with `crypto.subtle` (`hash_mismatch` on failure), then pass it as `modelAssetBuffer`.
4. `delegate: 'CPU'` for both tasks (the models run on the CPU). **WebGL2 is still required:**
   MediaPipe 1.0.1 uploads every frame as a texture on the task's WebGL context and reads it
   back for the CPU graph. Each task gets its own 1×1 `OffscreenCanvas` (`canvas` option) so the
   pipeline can watch that context: after a GPU reset (`webglcontextlost` or
   `isContextLost()`) MediaPipe keeps returning empty results, so `process` throws
   `VisionLoadError{code: 'process_failed', contextLost: true}` before running a model, and
   the session rebuilds the pipeline (§8.3). Never disable hardware acceleration (HANDOFF §1.0).

The desktop serves the fixed URLs of `ANALYSIS_ASSETS` through the privileged `centrate-ai` scheme.

### 5.2 Network lockdown (finding from proposal B, verified)

`vision_bundle.mjs` of 1.0.1 has a usage logger. Every 60 s it POSTs task type, running
mode, OS, version and latency statistics to `https://odml.pa.googleapis.com/v1/log`.
`enableLogging` is declared in the `.d.ts` but cannot turn it off. No images are sent, but
it breaks «nada sale del ordenador» and «cero telemetría».

**Fix: the analysis window has no network at all.**

- Its session cancels every http, https, ws and wss request.
- Its CSP `connect-src` allows only `centrate-ai:`.

When the POST fails, the logger clears its own interval, so it stops after one attempt.
`MEDIAPIPE_NETWORK_HOSTS` is exported, and the guard test fails if a MediaPipe upgrade
adds a host. The demo sets the same `connect-src` in a CSP meta tag.

### 5.3 Face Landmarker

**Options:**

| Option                               | Value     |
| ------------------------------------ | --------- |
| `runningMode`                        | `'VIDEO'` |
| `numFaces`                           | 2         |
| `outputFaceBlendshapes`              | true      |
| `outputFacialTransformationMatrixes` | true      |
| `minFaceDetectionConfidence`         | 0.4       |
| `minFacePresenceConfidence`          | 0.4       |
| `minTrackingConfidence`              | 0.4       |

- `detectForVideo` timestamps are strictly increasing: `max(last + 1, round(frame.t))`.
- **Choosing the user's face:**
  - Ignore faces with box height < 0.08.
  - Score = area × (1 + 2·IoU with the previous user box). Pick the highest.
  - `faces` = the number detected.
  - There is no identity recognition, on purpose.
- **Pose** (`poseFromMatrix`):
  - `data` is 4×4, column-major by default (`m[c*4+r]`).
  - Auto-detect the layout: if `|m3|+|m7|+|m11| > |m12|+|m13|+|m14|`, transpose.
  - f = normalize(m8, m9, m10) is the face's +Z (out of the face) in camera space. u = normalize(m4, m5, m6) is the face's +Y.
  - `yaw = atan2(f.x, f.z)`
  - `pitch = atan2(f.y, hypot(f.x, f.z))`
  - `up0 = normalize(Y − (Y·f)f)`, `right0 = up0 × f`, `roll = atan2(u·right0, u·up0)`
  - Degrees. Return `null` for NaN or `f.z ≤ 0`.
  - Signs: `yaw > 0` means the face is turned towards the image's right; `pitch > 0` means up, so writing and reading are negative.
  - The signs are pinned by composing matrices in tests (±80° grid, error < 0.5°, scaled and translated matrices, both layouts). There is also **one manual check in the demo**: look down, pitch must go negative. The classifier is baseline-relative and tolerates a sign error, but the looking-down floor does not.
- **Blendshapes**, read by `categoryName` (map the index once, never assume the order):

  | Feature    | Formula                                                                                                     |
  | ---------- | ----------------------------------------------------------------------------------------------------------- |
  | `blink`    | mean(eyeBlinkLeft, eyeBlinkRight)                                                                           |
  | `lookDown` | mean(eyeLookDownLeft, eyeLookDownRight)                                                                     |
  | `lookUp`   | mean(eyeLookUpLeft, eyeLookUpRight)                                                                         |
  | `gazeX`    | ½[(eyeLookOutLeft + eyeLookInRight) − (eyeLookInLeft + eyeLookOutRight)], clamped to −1…1, same sign as yaw |
  | `jawOpen`  | jawOpen                                                                                                     |

  The 52-value vector is never kept.

- **Box:**
  - The box is the min/max of the 478 landmarks, normalised.
  - `truncated` = share of landmarks outside [0, 1].
  - `jitter` = median displacement of about 20 stable landmarks (eye corners, nose bridge) since the previous frame, divided by box height. It is 0 with no previous frame.
  - Landmarks are used in the frame's scope only.

### 5.4 Object Detector

**Options:**

| Option              | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| model               | EfficientDet-Lite0 int8                                                  |
| `runningMode`       | `'VIDEO'`                                                                |
| `categoryAllowlist` | `['person', 'cell phone', 'book']` (all three are in the model's labels) |
| `scoreThreshold`    | 0.3                                                                      |
| `maxResults`        | 6                                                                        |

It runs only on the frames the loop asks for (`objects: true`, about 1 Hz).

- **Per run:** keep every `cell phone` with area ≥ 0.4 % of the frame (for the tracker), the best `book`, and the best `person` with area ≥ 5 %. Boxes are normalised from pixels. The reported `phone` is the best one that looks in hand (near the face or moving), else the best one, so a phone on a stand never hides the one in the hand.
- **Hold:** between runs the last values are returned with `fresh:false` and a growing `ageMs`. `objects` becomes `null` after `objectHoldMs` (4 s) or after `reset()`.
- **Phone tracker** (across runs, up to 4 objects: a phone on a stand, a calculator, the phone in hand). All tests are in pixels, because a detector box of an object that does not move jitters by 1–3 px per edge at 320×240 (an IoU test on a 32×19 px desk box failed on almost every run):
  - **Spot:** where the phone stopped, the mean of its first 4 sightings. A sighting is _still_ at it when the centre is within max(4 px, 0.15 × diagonal) and the area within 30 % (+ 3 px of edge jitter per side).
  - `stillMs`: time since the phone arrived at its spot. A phone missed by the detector is remembered by its spot for 60 s, so flicker never restarts it. Stray sightings (jitter, one glitch) keep it; 4 strays among the last 8 sightings (a hand wobbling around one place) or two clear moves in a row start a new spot. 0 while moving.
  - `moving`: the sighting is clearly away (centre > max(4 px, 0.25 × diagonal) or area > 50 %) from its spot and from the previous sighting (≤ 5 s ago).
  - `nearFace`: the box overlaps the user's face box, or its centre is within `fcx ± 1.2·fw` and between the top of the face and 1.5·fh below the chin. Not for a box touching the bottom edge (the desk) unless it moves, and never for a phone at rest (still ≥ 20 s). Uses the last face box if it was seen ≤ 10 s ago.
  - A phone at rest (still ≥ 20 s, `isResting`) is no phone evidence anywhere: DECISION's E_phone, the generic classifier and the classifier rows (LEARNING) all leave it out.

### 5.5 Luma (1 Hz)

- The frame is drawn to a 32×24 `OffscreenCanvas` (`willReadFrequently`), converted to grey, turned into stats, and the array is dropped.
- The pure part takes a `GrayThumbnail`, so it can be tested in Node.
- **Stats:** `mean`, `spatialStd`, `temporalDiff` (against the previous thumbnail), and `motionNearFace` (the diff inside the last face box enlarged ×2).
- **Covered:** `spatialStd < 0.025 ∧ (mean < 0.08 ∨ temporalDiff < 0.004)`. This catches a finger, a sticker, a closed lid or a wall.
- **Low light:** `mean < 0.18 ∧ ¬covered`. When low light holds for 5 s, detector inputs are drawn with `filter: brightness(g) contrast(1.1)`, with g = clamp(0.4/mean, 1, 3), onto a reused 320×240 canvas.
- Luma values are held ≤ `lumaHoldMs` (2 s).

### 5.6 Frame quality

Frame weight q is clamped to [0.2, 1]:

- With a face: q = 1 − 0.5·truncated − min(0.4, jitter/0.02) − 0.2·lowLight.
- No face but a person: 0.6.
- Otherwise: 0.2.

### 5.7 `VisionPipeline.process`

- Synchronous: face on every call; objects and luma only when asked.
- Returns `FrameFeatures` plus `VisionCost` (`performance.now()` deltas).
- It does not close the frame; the loop does, in `finally`.
- `reset()` after a camera restart or a gap.

### 5.8 Camera and frames

**`openCamera`:**

- `getUserMedia({ video: { width: {ideal: 320}, height: {ideal: 240}, frameRate: {ideal: 5, max: 10}, resizeMode: 'crop-and-scale', deviceId? }, audio: false })`.
- Frames come from `ImageCapture.grabFrame()`, which pulls from the capture pipeline and does not depend on page visibility. The fallback is a detached, muted, `playsInline` `<video>` passed straight to `detectForVideo`.
- `next()` resolves to an `AnalysisFrame` whose `close()` closes the ImageBitmap. It resolves to `null` when nothing arrives within 2 s.

**Status:**

- Starts at `starting`, then `ok`.
- `stalled` after 3 s without frames, or while the track is `muted`.
- `error` when the track `ended` (device unplugged, OS revoked access).

**Errors** (`CameraOpenError.code`):

| getUserMedia error                       | Code                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `NotAllowedError`                        | `permission_denied`                                                                        |
| `NotReadableError` / `AbortError`        | `in_use`, or `blocked_by_system` when main says OS privacy blocks the camera (see HANDOFF) |
| `NotFoundError` / `OverconstrainedError` | `not_found`                                                                                |
| no `mediaDevices`                        | `unsupported`                                                                              |

**Other:**

- `identity()` → `{ key: 'sha256:' + hex(SHA-256(label + '|' + W + 'x' + H)), aspect: W/H }`. The raw label never leaves the function.
- `stop()` stops every track and is idempotent.

### 5.9 PERCEPTION tests

- **pose:** grid round trip, both layouts, scale, NaN, `f.z ≤ 0`.
- **blendshapes:** shuffled order, missing names → 0, gaze signs.
- **face selection:** a second small face never wins; continuity.
- **objects:**
  - allowlist and area gates;
  - `nearFace` / `moving` / `stillMs`;
  - hold and expiry at 4 s;
  - `fresh` only on run frames.
- **luma:** synthetic arrays for covered, dark and normal; motion inside the face box.
- **quality:** formula bounds.
- **extractor:** plain-object fixtures shaped like MediaPipe results give finite, clamped numbers even from NaN or Infinity inputs.
- **models:** committed files match the manifest; `fetch-models --check` exits 0.
- **Browser parts:** covered by RUNTIME's Playwright smoke test (§8.8), not by vitest.

## 6. LEARNING

### 6.1 Calibration flow

- **Order:** screen → paper (book or notebook) → phone → away → absent. This is the order of `CALIBRATION_CLASSES`.
- **Recording:** each situation is recorded for 20 s at 4 fps, with objects every 2nd frame (2 Hz) and luma at 1 Hz. The first 2 s and the last 1 s are discarded, leaving ≤ 80 rows.
- **Wizard prompts** (the desktop owns the strings):
  - look at every screen you study with;
  - write and turn pages;
  - hold the phone as you usually do;
  - look around the room;
  - leave the camera's view.
- **Re-recording one situation** replaces that clip only; feedback rows are kept. **«Recalibrar»** (all five) is a clean slate that drops the feedback rows.

### 6.2 `CalibrationRecorder` and issues

`push(frame)` keeps rows while `phase === 'recording'`. `progress` exposes `liveIssues` so the
wizard can say «no te veo» before the 20 s run out.

**Issue codes:**

| Code              | Severity | Condition                                                                                                                 |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `too_short`       | error    | < 40 rows                                                                                                                 |
| `no_face`         | error    | face or person present in < 70 % of rows (every class except `absent`)                                                    |
| `too_dark`        | error    | median luma < 0.1                                                                                                         |
| `covered`         | error    | ≥ 30 % covered                                                                                                            |
| `still_visible`   | error    | `absent` with face or person present in > 20 %                                                                            |
| `phone_not_seen`  | warning  | `phone` with phone score ≥ 0.3 in < 20 % of detector runs                                                                 |
| `same_as_screen`  | error    | `away` with median \|dyaw\| < 12° and \|dpitch\| < 10° from screen                                                        |
| `unstable`        | warning  | `screen` pose IQR > 15°                                                                                                   |
| `missing`         | error    | a class with no clip at build time                                                                                        |
| `weak_separation` | warning  | set after training, with the confused `pair`, when the CV binary balanced accuracy is < 0.85; the profile is still usable |

### 6.3 Stored rows (`FEATURE_SCHEMA` 1)

- The 22 `FEATURE_ROW_COLUMNS` are absolute values, so a new baseline re-derives everything.
- `frameToRow` quantises at record time (angles 0.1°, the rest 0.001), so the JSON round trip is exact and a reloaded profile retrains to the same model.
- A face-less row has face = 0 and the face columns = 0.

### 6.4 Baseline, thresholds, eyes

- **Baseline:** medians of the `screen` rows (yaw, pitch, roll, cx, cy, w, h).
- **`thresholds.phone`:** clamp(p95 of phone score in the `screen` and `paper` rows + 0.1, 0.45, 0.8). This absorbs a calculator or a phone lying in view during calibration. The default is 0.5.
- **`thresholds.person`:** clamp(p95 of person score in the `absent` rows + 0.1, 0.4, 0.8). This absorbs a coat on the chair. The default is 0.5. This is what the «no estoy» clip teaches.
- **`eyes.blinkFit`:** a robust fit (Theil–Sen) of blink ≈ a + b·dpitch on `screen` + `paper` rows, because reading lowers the eyelids.
- **`eyes.reliable`:** false when the screen blink std is > 0.15 or its median is > 0.5 (glasses glare).
- **`eyes.closedDelta`:** 0.35. Without a profile, 0.45.

### 6.5 Classifier vector and expansion

**x, 16 dimensions:**

`face, dyaw, dpitch, droll, gazeX, gazeY(=lookUp−lookDown), dcx, dcy, logScale, blink, phone, phone·phoneNear, phone·phoneMoving, book, person, (1−face)·person`

- `dcx = (cx−cx0)/w0`, `dcy = (cy−cy0)/h0`, `logScale = ln(h/h0)`.
- **Robust standardisation:** (x − median)/max(IQR/1.349, floor). The floor is 3° for angles and 0.05 for the rest. Center and scale are stored in the model.
- Face-dependent standardised values are multiplied by `face`, so no face → 0, never a fake pose.

**φ(x):**

- x itself;
- dyaw², dpitch², dyaw·dpitch;
- K ≤ 4 RBF features `exp(−‖z−a_k‖²/2σ²)·face`, over z = (dyaw, dpitch, gazeX), standardised:
  - the anchors come from seeded k-means++ on `screen` + `paper` rows;
  - σ = 1.5 × the median distance to the nearest anchor, with a floor of 0.5.

This lets a convex linear model learn several «studying» directions: a second monitor, the notebook, an off-axis webcam.

### 6.6 Model and training

- **Model:** multinomial logistic regression over the 5 classes. Rows from every clip are used; the `absent` rows teach the empty-scene answer for hidden frames.
- **Objective:** J = −(1/Σw) Σ wᵢ log softmax(Wφᵢ + b)_{yᵢ} + (λ/2)‖W‖². The bias is not regularised.
- **Weights:**
  - The total weight of each class is equalised.
  - Feedback rows weigh 1.5 each, but a class's feedback total is capped at 50 % of its calibration weight.
- **Optimiser:** Nesterov accelerated gradient with adaptive restart.
  - Step 1/L, with L = ½·maxᵢ‖φᵢ‖² + λ.
  - Starts from zero; stops at ‖∇‖∞ < 1e-5 or after 2 000 iterations.
  - Log-sum-exp in the softmax.
- **λ selection:** blocked 4-fold CV. Fold k holds out the k-th contiguous quarter of each clip, so neighbouring frames never leak. The grid is {1e-4, 1e-3, 1e-2, 1e-1}. The winner is the best out-of-fold **binary** (study vs. not) log-likelihood; confusing screen with paper, or phone with away, does not matter.
- **Determinism:** no `Math.random` (seeded `mulberry32` for k-means++ and augmentation). Two runs are bit-identical.
- **Cost budget:**
  - full `buildProfile` (CV + final) ≤ 2 s;
  - feedback retrain (warm start, fixed λ, center, scale and anchors, ≤ 300 iterations) ≤ 300 ms;
  - `predict` ≤ 0.1 ms.
- **Stale trainer:** a profile whose `trainer` ≠ `PROFILE_TRAINER_VERSION` is retrained from `samples` on load. The facade emits `profile_updated{reason:'migrated'}`.

### 6.7 Trust π

For c ∈ {phone, away}: π_c = P(truly study | predicted c), from the out-of-fold predictions,
with Laplace smoothing, capped at 0.8. A user whose phone posture looks like their reading
posture thereby stops being punished for reading. The phone rule (§7.3) still catches a
visible phone.

### 6.8 Augmentation (seeded, pseudo-rows weigh 0.3)

- ±3° pose noise.
- Blendshape noise at 0.5 × the class σ, so the model depends less on the eyes.
- Copies of `screen`/`paper` rows with phone = 0.8 and phoneNear = 1, labelled `phone` (a visible phone means phone, whatever the pose).
- Copies of `paper` rows with book ∈ {0, 0.7} (independent of the detector).
- `absent` rows pinned at face = 0 and person below threshold.

### 6.9 Generic classifier (no profile, other camera, stale profile)

**Study directions** (one per screen; learned for the whole session, never frozen):

- A **calm** frame faces a screen: lookDown < 0.45 and absolute pitch > −20°. Writing or reading right after the click on «Empezar» is therefore never the screen pose.
- **Opening baseline:** the median pose and box of the first 20 s of calm face frames without a distraction or a phone. Failing 3 s of those, of such frames with lookDown < 0.45; failing that, of the first 20 s of face frames. A screen watched without input (a lecture) becomes the baseline this way.
- **Input directions:** calm face frames with fresh input (`hint.idleMs` < 2 s; `inputActive` when the caller omits the field), no F_dist and no phone. A pose seen like that for 3 s (gaps < 5 s, otherwise the candidate starts over) becomes a direction; its centre is the rolling median of its last 80 samples.
- At most 3 directions, the opening baseline included while no input direction lies within 12° of it. The least recently looked-at one makes room for a new one; directions that drift within 12° of each other merge.
- Until 3 s of face frames exist, `ready = false` and `predict` returns a neutral study-leaning answer (p_screen 0.8).
- A second monitor the user types or scrolls on is thereby a screen. One only watched, never touched, is not: pose alone cannot tell it from looking away (see §11).

**Rules** (against the direction that fits best: lowest rule cost, then the nearest; `relativePose` uses the same one):

- pStudy = exp(−(max(0,|dyaw|−10)/30)⁴ − (max(0,dpitch−15)/15)⁴) when dpitch ≥ −70°. Looking down counts as study.
- pStudy is split into screen/paper by the sign of dpitch.
- p_phone = pStudy-independent phone evidence × 0.9.
- The rest goes to `away`.

**Other values:**

- Trust {phone: 0, away: 0}.
- Thresholds: phone 0.5, person 0.5.
- Eyes, judged online: from the last 240 blink values of calm fresh-input frames (fewer than 20: of the opening baseline's calm frames). The profile's glare rule applies: unreliable when the median is > 0.5 or the spread is > 0.15. The spread is IQR/1.349, so real blinks and eyes closed just after the last keystroke do not count. Fit (clamp(median, 0.15, 0.5), −0.004), `closedDelta` 0.45. With fewer than 20 values the eyes are unknown (unreliable): no drowsiness from eyes not yet seen.

### 6.10 «¡Estaba estudiando!» learning

`learnFromFeedback(profile, episode, {nowIso})`:

- **Labels:** each frame is `paper` when `lookingDown` or `book`, otherwise `screen`.
- **Storage:** rows go through `frameToRow` into a FIFO of `feedbackRowsPerClass` (300) feedback rows per class.
- **Retrain:** warm, as in §6.6. `updatedAt` is set.
- **Result:** `{ok:false, reason:'no_usable_frames'}` when nothing usable is left.
- It never reads or writes strikes: the guardian never refunds.

### 6.11 Profile format and validation

`profile.json` lives in `userData/study-ai/`. Main writes it atomically and «Borrar todos mis
datos» deletes it. The shape is `CalibrationProfile` (numbers, ISO dates and fixed strings only).

- **`serializeProfile`:** canonical JSON with stable key order. About 60–150 KB.
- **`parseProfile` rejects:**

  | Error                | Cases                                                                                                                   |
  | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | `syntax`             | not JSON                                                                                                                |
  | `too_large`          | > 512 KB or > 5 000 rows                                                                                                |
  | `non_finite`         | NaN, Infinity                                                                                                           |
  | `schema`             | unknown or missing keys, wrong lengths, class index out of range, camera key not `^sha256:[0-9a-f]{64}$`, dates not ISO |
  | `format` / `version` | wrong format or version; the UI then asks to recalibrate                                                                |

  Migrations are per version (`MIGRATIONS[version]`).

- **`profileMatchesCamera`:** same `key` and aspect within 2 %. When it does not match, the session uses the generic classifier and shows the `recalibrate` hint.

### 6.12 LEARNING tests

- **softmax:**
  - separable blobs ≥ 98 %;
  - finite-difference gradient check;
  - bit-identical twice;
  - warm start converges in fewer iterations to within 1e-6;
  - 10:1 imbalance keeps minority recall ≥ 0.9;
  - zero-variance features give no NaN;
  - ±1e6 inputs still give probabilities summing to 1.
- **CV:** no leakage across folds; π on a designed confusion.
- **recorder:** settle/tail trimming, the cap, and each issue code.
- **profile:**
  - `parse(serialize(p))` equals p, and the retrained model is identical;
  - every rejection case;
  - a leaf walk asserting only numbers and allowed strings.
- **Personas** (via `calibrationFrames` from `test/synth`): every persona builds a usable profile; `offAxisCamera` and `secondMonitor` classify their study activities as study.
- **Feedback:** a new posture (tablet) is `away` before and study after; phone and absent frames never get in.
- **Performance** bounds from §6.6.

## 7. DECISION

### 7.1 Presence (per tick, `CameraObserver.observe`)

Checked in order; the first match wins:

| Condition                                                                                                                | Presence      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| camera `stalled` / `error` / `starting`, or frame `null` with camera not `ok`                                            | `camera_lost` |
| `luma.covered`                                                                                                           | `covered`     |
| face                                                                                                                     | `visible`     |
| person ≥ `thresholds.person` in any of the last 3 detector runs, or (`motionNearFace ≥ 0.02` and a face seen ≤ 10 s ago) | `hidden`      |
| otherwise                                                                                                                | `absent`      |

A null frame while the camera is `ok` keeps the previous presence, with `study: null`.

### 7.2 Evidence persistence

The observer keeps the detector runs of the last 6 s (fresh frames only).

- **`phone`** (E_phone): phone ≥ `thresholds.phone` ∧ (nearFace ∨ moving) ∧ stillMs < 20 s ∧ _in use_ (moving ∨ lookingDown ∨ the box overlaps the face ∨ no face in view), in ≥ 60 % of the runs of the last max(5 s, 2 runs). A phone that does not move near a user who visibly looks at the screen is a timer on a stand, not a phone in hand.
- **`book`** (E_book): book ≥ 0.35 in ≥ 50 % of the runs of the last max(6 s, 2 runs).
- **`lookingDown`:** visible ∧ (rel.dpitch ≤ −12° ∨ lookDown ≥ 0.45) ∧ |rel.dyaw| ≤ 35°. Without `rel` (generic not ready), absolute pitch ≤ −20° is used.
- **`distractionApp`** (F_dist): foreground `distraction` continuously for ≥ 5 s.
- **`inputActive`:** idleMs < 15 s. Null idle counts as inactive.

### 7.3 Fusion: the instant study value s ∈ [0, 1]

Notation: θ = `focusScoreThreshold`, p = `classifier.predict(frame)`, π = `classifier.trust`,
and **floor = min(95, θ + 20)/100**. The floor is always ≥ θ + H, so looking down is never
«low» at any sensitivity.

**Base value, by presence:**

| Presence                           | s                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `visible`                          | p.screen·(F_dist ? 0.1 : 1) + p.paper + π.away·p.away + (E_phone ? 0 : π.phone·p.phone) |
| `hidden`                           | max(p.screen + p.paper if p exists, last-pose rule)                                     |
| `absent`, `covered`, `camera_lost` | `null`: not pushed; the absence path handles it                                         |

Hidden last-pose rule: look at the last visible relative pose within 2 s before the face was lost.

- **down** (dpitch ≤ −12°): floor, for up to 10 min of continuous hidden time;
- **turned** (|dyaw| ≥ 35°): 0.2;
- **unknown:** (θ + 5)/100 for 20 s, then 0.2.

**Then, in order:**

1. If ¬E_phone ∧ (lookingDown ∨ E_book): s = max(s, floor).
2. If inputActive ∧ ¬F_dist ∧ ¬E_phone: s = min(1, s + 0.10). Keyboard and mouse are a weak signal.
3. If E_phone: s = min(s, 0.10). A phone in hand overrides everything.
4. Drowsy candidate (below): s = null. Not pushed, timers freeze.

A distraction in the foreground discounts only the «looking at the screen» share. This is
the brief's «aunque mires la pantalla»: writing in a notebook with music in the foreground
stays study.

**Other outputs:**

- **Cause** (when s < θ/100):
  - E_phone → `phone`;
  - else F_dist → `distraction_app`;
  - else argmax is away, or presence is hidden-turned → `looking_away`;
  - else `unknown`.
- **Weight** = `frame.quality`.
- **Hints this tick:**
  - `low_light` (luma);
  - `camera_covered` (covered);
  - `camera_cant_see_you` (hidden for > 60 s, or truncated > 0.3);
  - `recalibrate` (stale profile, sticky).

### 7.4 Eyes and the stale-profile check

- **Closed frame:**
  - eyes reliable ∧ visible ∧ q ≥ 0.5;
  - blink − (a + b·dpitch) > closedDelta;
  - lookDown < 0.5.
- **Yawn:** jawOpen > 0.6 for ≥ 2 s.
- **Drowsy** (engine):
  - starts when closed ≥ 80 % of the last 20 s (with ≥ 50 % coverage), or PERCLOS ≥ 0.3 over 60 s;
  - ends when the eyes are open ≥ 70 % of the last 5 s.
- **`suggest_break`:**
  - `eyes_closed` on entering drowsy;
  - `yawning` after 3 yawns in 5 min;
  - at most one per 10 min, never a strike.
- **Stale profile** (personal classifier only): in the first 120 s, among face frames with input active and no F_dist, if there are ≥ 60 such frames and ≥ 70 % have argmax `away`:
  - switch to the fallback (generic) classifier;
  - raise the sticky `recalibrate` hint.

### 7.5 Smoothing and hysteresis (engine)

**Long score:**

- The window is W = `focusWindowMs`. Each sample weighs its `weight` × the time it represents (the gap since the previous sample, capped at 1 s).
- Score = round(100 × weighted mean).
- Windows are measured in time, not frames, so they mean the same at 2, 3 or 4 fps.

**Short score:** the same over 3 s.

**`low`:**

- **Enters** when score < θ, the window is ≥ 50 % full (in time), and the state is not `warmup`.
- **Leaves** when score ≥ θ + 8, or short score ≥ min(θ + 16, 90) (fast recovery).
- **In between**, the previous value is kept.

**Cleared** (window and low reset) on: gap, phase change, return from `away`, observer switch, resume.

### 7.6 State machine

Per tick, dt = now − previous tick:

- If dt > `gapResetMs` (5 s: suspend, frozen renderer, camera restart), reset timers and windows, go to `warmup` (10 s), and credit nothing. Time that was not observed is never punished.
- Otherwise the step is min(dt, 2 s).

**Timers:** `lowMs`, `doubtMs`, `absentMs`, `presentMs`, `graceUntil`.
**Absent-like:** `absent` or `covered` now, or `camera_lost` for ≥ 10 s.

| From                   | Condition                           | To / events                                                                                   |
| ---------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| any                    | phase `break` / `paused`            | `break` / `paused`. Windows, low, lowMs, doubtMs, absentMs and drowsy reset. No other events. |
| any                    | phase `ended`                       | `ended`. Nothing more.                                                                        |
| break / paused / ended | phase `work`                        | `warmup` (10 s)                                                                               |
| warmup                 | elapsed ≥ 10 s (3 s after `away`)   | `focused`                                                                                     |
| warmup, focused, doubt | absent-like continuously ≥ 3 s      | `away` («No te veo»); lowMs and doubtMs cleared                                               |
| away                   | present continuously ≥ 2 s          | `warmup` (3 s), window cleared                                                                |
| focused                | low; lowMs ≥ `doubtAfterMs`         | `doubt` + `warning{doubt}`                                                                    |
| focused                | not low                             | lowMs = 0                                                                                     |
| doubt                  | not low                             | `focused` + `doubt_cleared{score}`                                                            |
| doubt                  | low; doubtMs ≥ `strikeAfterDoubtMs` | `strike{cause}` (§7.7) → grace, `focused`                                                     |
| any work state         | absentMs ≥ `noFaceStrikeMs` / 2     | `warning{absent}`, once per absence                                                           |
| any work state         | absentMs ≥ `noFaceStrikeMs`         | `strike{no_face}` → grace, absentMs = 0                                                       |

- **Absence accumulator:** `absentMs` grows while absent-like, counted from the first absent frame (also during warmup). It resets only after `absenceResetMs` (10 s) of continuous presence. Popping back for 5 s every 55 s does not help.
- **Grace:** `graceUntil = strike + strikeGraceMs` (60 s).
  - During grace, lowMs, doubtMs and absentMs are held at 0, and DUDA cannot be entered.
  - The state shows `focused` or `away`.
  - `strikeResult{counted:false, reason:'cooldown', cooldownLeftMs}` extends the grace to max(ours, now + cooldownLeftMs). `not_in_work_phase` needs nothing, because the phase follows.
- **Resulting cadence:**
  - continuous distraction strikes at ≈ 52 s, then every ≈ 105 s;
  - continuous absence strikes at 60, 180 and 300 s.
- **Drowsy:** lowMs and doubtMs freeze (neither grow nor reset).
- **Strike events** carry `seq` (1, 2, 3… per engine run). Main uses `<sessionId>:<runId>:<seq>` as the idempotency key.

### 7.7 Strike cause (doubt path)

Over the time spent `low` since the doubt timer started:

- phone evidence ≥ 40 % → `phone`;
- else F_dist ≥ 40 % → `distraction_app`;
- else `doubt_timeout`.

The absence path is always `no_face`. `strikeCauseFor(lowCause)` maps a single cause the
same way.

### 7.8 Heartbeat state, credit and totals

- **`heartbeatState(snapshot)`:**

  | Snapshot                        | Heartbeat state |
  | ------------------------------- | --------------- |
  | warmup/focused ∧ ¬low ∧ ¬drowsy | `focused`       |
  | doubt, or low, or drowsy        | `doubt`         |
  | away                            | `away`          |
  | break                           | `break`         |
  | paused, ended                   | `paused`        |

  It is informational only.

- **Credit:** focusedMs += step while phase = work ∧ state ∈ {warmup, focused} ∧ ¬low ∧ ¬drowsy ∧ not absent-like. The grace does not stop credit.
- **Totals are cumulative:** `focusedMs`, `warnings` (every `warning` event), `strikesRequested`, `ticks`, `workMs`. Main sends deltas.

### 7.9 Timeline

- **Segments** are relative to `startedAt`, one of: `focused`, `low`, `doubt`, `away`, `drowsy`, `break`, `paused`.
- Neighbours of the same kind are merged, and pieces < 5 s are absorbed into the previous segment.
- **Marks:** `warning`, `strike` (with cause), `suggest_break`.
- **`bucketizeTimeline`:** fixed buckets; the worst kind wins, in the order away > doubt > low > drowsy > focused, with break/paused only when nothing else applies.

### 7.10 Feedback episodes

- **Opening:** entering `doubt`, entering `away`, and a strike each open an episode.
- **Frame span:** from max(entry − `doubtAfterMs`, now − 60 s) to the click.
- **Availability:** an episode is available while it is the latest one and it started ≤ 90 s ago. Observations are kept in a 90 s in-memory ring and never stored.

**`feedbackEpisode(now)`:**

- **Rejections:**
  - `no_camera` in no-camera mode;
  - `limit_reached` after 5 applied per session;
  - `no_episode`;
  - `already_used`.
- **Frames:** up to 30 evenly spaced frames with phase = work, presence visible or hidden, no E_phone, and frame ≠ null. When none qualify → `no_usable_frames`.
- The facade returns `not_calibrated` itself when the classifier is generic.

**`applyFeedback(now, id)`** runs after the facade has swapped the classifier:

- Marks the episode used.
- Recomputes each window sample with `observer.rescore`, then recomputes score and low.
- If the state is `doubt` and the new long score is ≥ θ + 8, it goes to `focused` and emits `doubt_cleared{by:'feedback'}`. Otherwise nothing changes.
- During grace there is nothing to refund.

### 7.11 Hints

- Observation hints active for ≥ 5 s → `hint{active:true}`.
- Inactive for ≥ 5 s → `hint{active:false}`.
- `snapshot.hints` is the active set. The facade merges in its own hints: `camera_lost`, `over_budget`, `throttled`, `vision_failed`.

### 7.12 DECISION tests

Unit tests use an oracle classifier (fixed probabilities, a configurable relative pose) and
a fake clock.

**Fusion:**

- every rule of §7.3;
- F_dist only discounts p.screen;
- the floor is ≥ θ + 8 for every θ in 30..80;
- the phone cap beats book, looking down and hidden.

**Smoothing:**

- irregular dt;
- the same mean at 2, 3 and 4 fps;
- the 50 % fill rule;
- no flapping for a signal oscillating ±5 around θ (≤ 1 low transition per minute);
- fast recovery.

**Machine** (table-driven):

- exact 15 s / 30 s / 60 s timings for all tunable values;
- absence takes priority over doubt;
- face flicker (1 frame every 10 s) does not reset absence;
- the 60/180/300 s cadence;
- grace extension on a non-counted strike;
- break and pause of any length emit nothing;
- a 10-min gap gives no strike;
- clamped settings;
- drowsy never strikes and suggests at most every 10 min;
- cause attribution;
- totals and credit;
- timeline merge;
- feedback selection (never phone or absent frames, one per episode, limit 5).

**Engine scenarios** (`test/synth` + oracle, then again with the real classifiers behind `implemented()`), at 2, 3 and 4 fps with 3 seeds.

_False positives (the core):_ every persona × {screen, notebook 20 min, readBook 20 min, secondMonitor, typing, coffeeSip, phoneOnDesk, phoneOnStand, stretch} must give 0 strikes, ≤ 1 warning per 20 min and ≥ 90 % focused time. A seeded fuzz of 50 random 30-min study-only scripts must give 0 strikes.

_True positives:_

| Scenario                                | Expected                                           |
| --------------------------------------- | -------------------------------------------------- |
| phoneInHand 2 min                       | doubt at 18–30 s, strike at 45–65 s, cause `phone` |
| lookAway                                | `doubt_timeout`                                    |
| lookAway 40 s then back                 | 1 doubt, 0 strikes                                 |
| absent, covered while typing            | `no_face` at 60 s ± one tick                       |
| distraction foreground while on screen  | `distraction_app`                                  |
| eyesClosed 2 min                        | `suggest_break`, no strike                         |
| any script with ≥ 70 s continuous phone | ≥ 1 strike                                         |

## 8. RUNTIME

### 8.1 Loop (`AdaptiveLoop`)

- **Timers:** only `TimerApi.set`. The next step is scheduled only after the current one settles, so steps never overlap.
- **Delay:** max(10, plan.intervalMs − elapsed) on a fixed-rate grid; more than an interval behind restarts the grid.
- **Hard duty cap:** a token bucket earns 0.15 ms of compute per ms (burst 300 ms) and each step spends its measured cost (`visionMs + objectMs + otherMs`; a step that threw is charged its wall time; an idle step nothing). A step that overdraws it waits until the bucket is back at zero, and the grid restarts after that wait. The wait for the next camera frame is not compute and never counts. A machine too slow for 2 fps therefore runs a controlled 1–1.5 fps instead of a busy loop; `overBudget` stays set for 10 s after the cap last delayed a step.
- **Errors:** counted in `stats.errors`, and the loop keeps going.
- **Stats:**
  - `maxGapMs` and measured `fps`;
  - `throttled` when the median timer lateness of the analysed frames over 30 s exceeds 250 ms (Chromium aligns a throttled hidden page's timers to 1 s wake-ups: the loop still ticks at 1 Hz), or under 1 tick/s for 30 s while running unless the duty cap spaced the ticks. Idle ticks (breaks) never count.
- **`stop()`** clears the pending timer, and a step in flight schedules nothing.

### 8.2 CPU governor (`CpuGovernor`)

- **Cost tracking:** an EMA (α = 0.2) of the vision, object and other costs. A single step over 400 ms is ignored as an outlier.
- **Prediction:** duty(L) = (vision + other + object/objectEvery) / interval.
- **Level choice:** pick the fastest level with predicted duty ≤ 0.08 (one core). This keeps the process under 15 % including capture and JS.
- **Direction:**
  - Start at L1.
  - Slow down immediately.
  - Speed up only after 10 s of predicted duty ≤ 0.75 × target.
- **Measured CPU:** `reportProcessCpu(pct)` above 12 % forces one level slower for 10 s.
- **Over budget:** L4 still over budget → the emergency level L5 (default levels only) with `overBudget` (hint `over_budget`); below that the loop's hard duty cap (§8.1).
- **No face visible:** objects run at ≥ 1 Hz anyway, because the person detector decides between hidden and absent.
- **Alert:** so they do while a phone (not at rest) was seen in the last 20 s, or the engine is in doubt (`StepCost.alert`). At L3/L4 PERCEPTION's tracker, which counts sightings, would otherwise take a phone wobbling in the hand for one at rest (sightings 4–8 s apart) and E_phone would drop. The alert is left out of the predicted duty (it lasts seconds; it must not walk the levels down), and the duty cap bounds it.

| Level       | Interval | fps | Objects every | Objects rate |
| ----------- | -------- | --- | ------------- | ------------ |
| L0          | 250 ms   | 4   | 2 frames      | 2 Hz         |
| L1 (start)  | 333 ms   | 3   | 3 frames      | 1 Hz         |
| L2          | 500 ms   | 2   | 2 frames      | 1 Hz         |
| L3          | 500 ms   | 2   | 4 frames      | 0.5 Hz       |
| L4          | 500 ms   | 2   | 8 frames      | 0.25 Hz      |
| L5 (emerg.) | 500 ms   | 2   | 16 frames     | 0.125 Hz     |

**Expected cost:** face ≈ 8–12 ms, detector ≈ 30–45 ms and luma < 1 ms per call. At L1 that is about 6–8 % of one core.

### 8.3 Session facade (`startStudySession`)

**Start:**

1. Resolve settings.
2. `parseProfile(profileJson)`:
   - an error means no profile, plus the `recalibrate` hint;
   - `migrated`, or a stale `trainer`, means retrain and emit `profile_updated{migrated}`.
3. **Camera mode:**
   - Load `createVision` first (≤ 30 s), then open the camera (≤ 15 s): the camera is never on while MediaPipe loads or when it cannot. `camera{starting}` is emitted the moment the stream opens.
   - The camera is named by label (`cameraLabel`) and resolved with `enumerateDevices()` on every open: `deviceId`s are salted per partition and run. A chosen camera that is missing → the default camera and the sticky `camera_default` hint.
   - `identity()` then decides the classifier: personal if `profileMatchesCamera`, else generic plus `recalibrate`.
   - The engine gets `new CameraObserver({classifier, fallback: createGenericClassifier()})`.
   - The start never rejects for a camera or vision problem (the guardian session already runs): a camera that fails → `camera{error}` then `mode{no-camera}`; a `VisionLoadError` → `mode{vision_failed}` and the `vision_failed` hint.
   - **Recovery:** when the cause may pass (camera `in_use`/`not_found`/`unknown`; a load that failed or timed out), retries run in the background after 30 s, 60 s, 2 min, then every 5 min, and a late pipeline is adopted. Success → `mode{camera, recovered}`. `continueWithoutCamera()` stops them.
4. **No-camera mode:** `new NoCameraObserver()`, ticked at 1 Hz.

**Loop step (camera mode, phase work):**

1. `frame = await source.next()`.
2. `vision.process(frame, {objects: due, luma: ≥ 1 s})`, with `frame.close()` in `finally`.
3. `engine.tick({now, phase, context, camera: source.status, frame: features | null})`.
4. `governor.record(cost)`.
5. Events go to `onEvent` at once. `onReport` fires every 1 s.

In phases other than work, and in no-camera mode, the step only ticks the engine, every 1 s.

**Context:**

- `setContext` stores the latest value.
- Context older than 5 s is treated as foreground `unknown` and idle `null`; the phase is kept.
- `visibleDistraction` (a catalog service playing on another display) with the input idle for ≥ 10 s reaches the engine as foreground `distraction` (`engineContext`): the same F_dist discount of p.screen, so paper stays study.

**Camera lifecycle:**

- **Breaks:**
  - Phase ≠ work for ≥ 10 s → `source.stop()` (camera light off, `cameraOn:false`).
  - Back to work → reopen, `vision.reset()`, and the engine sees `starting`, then warmup.
- **Stalls and errors:**
  - Retry opening every 10 s.
  - After 30 s failing, emit `camera{error}` so the UI can offer «Continuar sin cámara».
- **`continueWithoutCamera()`:**
  - Allowed only while the camera is not `ok`; returns false otherwise. This prevents covering the lens and switching to dodge a `no_face` strike.
  - It stops the camera, swaps in the `NoCameraObserver` (`engine.setObserver`) and emits `mode{user}`.
- **Vision failures:** 5 `process` failures in a row rebuild the pipeline once (often a dead WASM module); the same streak again without a good frame switches to no-camera mode (`mode{vision_failed}`, then the background recovery).
- **Lost WebGL context** (`VisionLoadError.contextLost`, or `vision.contextLost` on `resume()`): not a failure. The pipeline is rebuilt at once with `deps.createVision` (about 1 s, up to 30 s). Meanwhile the loop keeps taking and closing frames, so the camera stays `ok` and the engine keeps the last presence: nothing is counted as absent. A rebuild that fails or takes over 30 s, or a second loss within 60 s, switches to no-camera mode (`mode{vision_failed}`, then the background recovery).

**Other operations:**

- **`studyingFeedback()`:**
  1. Reject with `no_camera` or `not_calibrated` when those apply.
  2. `engine.feedbackEpisode(now)`.
  3. `learnFromFeedback(profile, episode, {nowIso})`.
  4. `observer.setClassifier(createPersonalClassifier(newProfile))`.
  5. `engine.applyFeedback(now, id)`.
  6. Emit the events and `profile_updated{feedback, serializeProfile(newProfile)}`.
  7. Return `{ok, added, doubtCleared}`.
- **`strikeResult`** → the engine. **`resume()`** → `engine.resume(now)`, `vision.reset()` (or a rebuild when its WebGL context was lost), camera re-check.
- **`stop()`:** stops the loop, the camera and vision, and returns `{totals, timeline}`.
- **Report:** `{runId, at, mode, camera, cameraOn, snapshot (merged hints), totals, loop}`.

### 8.4 No-camera observer

Presence is always `no_camera`, and there is no absence path. Let L = `noCameraIdleMs` × (1.5
when the foreground is `study`), and s_base = 1.0 for foreground `study`, otherwise 0.85.

| Condition           | s                   | Cause                               |
| ------------------- | ------------------- | ----------------------------------- |
| F_dist (≥ 5 s)      | 0.05                | `distraction_app`                   |
| idle ≤ L − 60 s     | s_base              | —                                   |
| L − 60 s < idle < L | falls linearly to 0 | —                                   |
| idle ≥ L            | 0                   | `idle` (strikes as `doubt_timeout`) |
| idle `null`         | 0.85                | —                                   |

- Weight is 1. No eyes, no frame. Any key or mouse input clears the doubt through the fast recovery.
- `rescore` returns the stored value.

### 8.5 Calibration session (`startCalibration`)

- Loads vision at start; opens the camera **per recording** (the camera is off between clips), by label like the session. A chosen camera that is missing fails the recording with `not_found` (never calibrates another camera).
- `record(cls)` runs a 250 ms loop (objects every 2nd frame, luma at 1 Hz) under the loop's duty cap. It feeds `CalibrationRecorder`, calls `onProgress` every step, and resolves with the summary when the clip ends: 20 s, extended up to 60 s (until ~50 rows) when the cap slows the frames; `remainingMs` follows the planned end.
- Only one recording at a time. `cancel()` rejects the pending one with `AbortError`.
- `build()` calls `buildProfile({recordings, previous, camera: identity, nowIso})` and returns `serializeProfile(profile)`.
- `close()` releases everything.
- Calibration runs **in the hidden analysis window too**, so MediaPipe lives in a single locked-down window. The visible wizard shows its own `getUserMedia` preview; frames never cross IPC.

### 8.6 Analysis host and IPC

- `createAnalysisHost({post, assets})` is all the hidden window's script needs.
- `handle(message)` validates with `isAnalysisInbound`; an invalid message → `error{invalid_message}`.
- It runs one session or calibration at a time; anything else → `error{busy}`.
- `list_cameras` works any time and answers `cameras` with labels only (never ids, never opening a camera).
- It maps the `AnalysisInbound` and `AnalysisOutbound` unions in `types.ts` one to one onto the facades.
- **Guards** (`isAnalysisInbound`, `isAnalysisOutbound`) are strict: known `type` values, exact keys, finite numbers, known enums, `profileJson` ≤ 512 KB.

### 8.7 Heartbeat accumulator (Electron main)

**Input:** `report(report, receivedAt)` records reports, keeping cumulative totals per `runId`.
A new `runId` starts a new baseline, so a restarted analysis window never re-sends old totals.

**`take(now)`** returns the next `HeartbeatBody`:

- `state = heartbeatState(snapshot)`;
- `focusScore = snapshot.score`;
- `focusedMsSinceLast` and `warningsSinceLast` = deltas, clamped to 0–600 000 and 0–100; anything above the clamp carries over;
- `cameraOn`.

**Other operations:**

- `restore(body)` gives back an unsent body.
- `alive(now)` is false when no report arrived, or when `totals.ticks` did not advance, for > 60 s. `take` then returns `null`: main stops heartbeating, and the guardian decides about abandonment (ARCHITECTURE §10.4).

### 8.8 Demo (`demo/`)

**Files:** `demo/index.html`, `demo/main.ts`, `demo/vite.config.ts` (`npm run demo -w packages/study-ai`).

**Serving:**

- Vite binds `127.0.0.1`.
- A small middleware serves `/mediapipe/*` from `@mediapipe/tasks-vision/wasm` and `/models/*` from `apps/desktop/resources/models`.
- A CSP meta tag with `connect-src 'self' ws://127.0.0.1:*` blocks the MediaPipe logger.

**Shows** live numbers only:

- pose, blink, lookDown, phone/book/person scores, presence;
- instant and smoothed score, state, timers;
- fps, duty, level.

**Controls:**

- the 5-step calibration;
- «¡Estaba estudiando!»;
- a sensitivity slider;
- a phase selector (work, break, paused);
- «Descargar perfil» (a local JSON file);
- an optional local preview.

**Manual checks it documents:**

- looking down makes pitch negative;
- turning towards the image's right makes yaw positive;
- a phone in hand shows `phone`.

**Playwright smoke test:**

- Files: `demo/smoke.pw.ts` and `demo/playwright.config.ts`, run with `npm run test:browser`. It is not part of `npm test`, and it must not be named `*.spec.ts` or vitest picks it up.
- Chromium via `PW_CHROMIUM_PATH` with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
- It runs 20 s of the real WASM and models and asserts:
  - ≥ 2 ticks/s;
  - finite features;
  - every non-loopback request was blocked. Record the attempt to `odml.pa.googleapis.com`.

### 8.9 `HANDOFF.md` (RUNTIME writes it for the desktop team)

**HANDOFF.md is the authoritative integration spec**: where it and this list differ (it has been
refined since, e.g. exactly-once heartbeats and strikes, camera labels, the foreground rule),
HANDOFF wins. It must cover:

1. **Hidden analysis window:**
   - `show:false`, `webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'centrate-ai' }`, a preload exposing only `post`/`onMessage`, loaded from the app bundle, never navigable.
   - `setPermissionRequestHandler`/`setPermissionCheckHandler` on that session allow `media` (video only) for it alone.
   - `session.webRequest.onBeforeRequest` cancels http, https, ws and wss.
   - CSP: `default-src 'none'; script-src 'self' centrate-ai: 'wasm-unsafe-eval'; connect-src centrate-ai:; img-src 'none'; media-src mediastream: blob:`.
   - `ANALYSIS_ASSET_SCHEME` registered as privileged (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) before `app.ready`.
   - `protocol.handle` on that session serves only `assets/mediapipe/vision_wasm_internal.{js,wasm}` and `assets/models/<manifest files>`: no traversal, `application/wasm` / `text/javascript` / `application/octet-stream`, `Access-Control-Allow-Origin: *`.
   - electron-builder `extraResources` copies `apps/desktop/resources/models/**` and the two WASM files from `node_modules/@mediapipe/tasks-vision/wasm/`.
2. **Camera permission:**
   - macOS: `NSCameraUsageDescription` (electron-builder `mac.extendInfo`), `systemPreferences.getMediaAccessStatus('camera')`, and `askForMediaAccess('camera')` only after the consent screen.
   - Windows: detect an OS privacy block from `HKCU` and `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam` (`Value` = `Deny`, including `NonPackaged`), read with a constant `reg query` argv or a native read, never with received data. Map it to `blocked_by_system` and explain Settings › Privacy › Camera.
   - Linux: the `/dev/video*` group hint.
3. **IPC:** the `AnalysisInbound`/`AnalysisOutbound` contract, validated on both sides.
4. **Main loop:**
   - Send `context` at 1 Hz: phase from `GET /v1/study/sessions/current`, foreground class from the active-window layer (`distraction` = **any** catalog service, `educationalCapable` ones such as YouTube included, unless the per-session «Voy a usar YouTube para estudiar» opt-in makes it `neutral`; `study` = the study whitelist; else `neutral`/`unknown`), the optional `visibleDistraction` flag, and `powerMonitor.getSystemIdleTime()` × 1000.
   - On each `strike` event, POST `/strike` with idempotency key `<sessionId>:<runId>:<seq>`; convert `cooldownUntil` to `cooldownLeftMs` and send `strike_result`.
   - Heartbeat every 15 s from `HeartbeatAccumulator.take`, at once after resume, and once when the planned end passes; stop when `take` returns `null`.
   - Forward `powerMonitor` `resume` as `resume`.
5. **Persistence:** atomic write of `profile_updated.profileJson` to `userData/study-ai/profile.json` (debounced), and deletion in «Borrar todos mis datos».
6. **UI mapping:**
   - meter texts per state and presence;
   - sounds on `warning`;
   - the «¡Estaba estudiando!» button on the doubt/strike notice;
   - hints to i18n strings;
   - «Continuar sin cámara» after `camera{error}`.
7. **Tests the desktop must add:**
   - Electron e2e with the fake camera: window hidden for 5 min, still ≥ 2 fps, CPU via `app.getAppMetrics()`;
   - killing the analysis window stops heartbeats within 60 s;
   - no network from the analysis window.

### 8.10 RUNTIME tests

- **Governor:**
  - level choice;
  - immediate slow-down and 10 s speed-up;
  - no flapping;
  - process-CPU override;
  - ≥ 1 Hz objects without a face;
  - the 2 fps floor;
  - outliers ignored.
- **Loop** (fake timers):
  - never overlaps;
  - `stop()`;
  - errors counted;
  - the rAF spy never called;
  - every frame closed exactly once, including on exceptions;
  - `throttled`.
- **No-camera observer:** the table in §8.4.
- **Heartbeat accumulator:**
  - deltas, clamps and carry-over;
  - `runId` restart;
  - `restore`;
  - dead after 60 s.
- **IPC guards:** every message type, plus a fuzz of malformed messages.
- **Facade** (in Node with fake `FrameSource`/`VisionPipeline` replaying `test/synth`):
  - camera stop and restart in breaks;
  - the camera-lost path;
  - `continueWithoutCamera` rules;
  - `vision_failed` fallback;
  - the feedback flow;
  - reports at 1 Hz.
- **`test/acceptance/`** (Phase 4 «terminado», behind `implemented()` until LEARNING and DECISION land). A calibrated persona through the real classifier and engine:
  - picking up the phone → warning, then a `phone` strike;
  - leaving → `no_face` at 60 s;
  - writing in a notebook for 30 min → 0 strikes;
  - three strikes are requested only when the behaviour continues.

## 9. Performance budget

| Item                                     | Budget                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Face Landmarker per frame (CPU, 320×240) | ≈ 8–12 ms                                                             |
| Object detector per run (int8)           | ≈ 30–45 ms                                                            |
| Luma per sample                          | < 1 ms                                                                |
| `engine.tick`                            | < 0.5 ms (100 k ticks < 1 s in Node)                                  |
| `classifier.predict`                     | < 0.1 ms                                                              |
| `buildProfile`                           | ≤ 2 s                                                                 |
| Feedback retrain                         | ≤ 300 ms                                                              |
| Steady-state memory                      | bounded rings only (90 s observations, 6 s detector runs, 60 s eyes)  |
| CPU                                      | duty ≤ 0.08 of one core by design; < 15 % measured, including capture |

## 10. Decisions and requests for the coordinator

1. **DECISIONS.md:** the MediaPipe runtime and both models are Apache-2.0, an exception to «solo CC0 u OFL» (as done for Lucide). The COCO annotations behind EfficientDet are CC BY 4.0. The Apache text and notices go in the app's third-party notices. `ASSET-LICENSES.json` already has the three entries.
2. **DECISIONS.md and PRIVACY.md:** MediaPipe's usage logging is blocked; the analysis window has no network.
3. **DECISIONS.md:** looking down counts as studying unless a phone is visible in hand. Known limitation: a phone hidden below the camera's view cannot be seen.
4. **DECISIONS.md:** «¡Estaba estudiando!» retrains and clears DUDA only if the retrained model agrees. It is limited to 5 per session and never refunds a strike (already in ARCHITECTURE).
5. **DECISIONS.md:** «Sin cara» means no face ∧ no person ∧ no motion near the face. A covered camera, or one that stalled for 10 s, counts as absent (fails closed). «Continuar sin cámara» is only offered when the camera is failing.
6. **DECISIONS.md:** an absence warning («No te veo» + sound) at `noFaceStrikeMs`/2 counts as a warning.
7. **`packages/study-ai/package.json`:** `@centrate/shared` belongs in `dependencies` (it is imported at runtime). I left it in `devDependencies` because moving it changes `package-lock.json`, and `npm ci` would fail until someone runs `npm install`. The workspace link already works either way.
8. **Optional:** move `focusWindowMs` (10–20 s) and `noCameraIdleMs` (3–20 min) into `STUDY_RULES` in shared, and the guardian's settings validation, when the Settings UI exposes them.
9. **Desktop work:** everything in §8.9 (HANDOFF.md).

## 11. Known limitations

- A phone held below the camera's view looks like reading or writing. It is not punished, by design.
- A phone held perfectly still in the hand (its centre within about 15 % of its diagonal for 20 s) reads as a phone at rest. Real hands wobble more; the classifier's `phone` posture still applies.
- A phone that appears already at rest near the chest (a stand in view when the session starts) counts as in hand for its first 20 s: at most one «¿Sigues ahí?», never a strike.
- A calculator held and moved near the face can read as a phone. The doubt period and the personal `thresholds.phone` soften this.
- With glasses glare (`eyes.reliable = false`) drowsiness detection is off; no strike is lost, since drowsiness never strikes.
- A camera change without recalibrating falls back to the generic classifier. It is less precise, but it never punishes looking down.
- The generic classifier learns a second screen only from keyboard or mouse input on it (§6.9). A second monitor that is only watched, at 40° or more, reads as looking away until the user types or scrolls there, or calibrates. The safety net is DECISION's: in generic mode a pose-only doubt (`looking_away`/`unknown`) should stop at DUDA (requested, not yet in §7.6).
- A video on a second monitor while a study app has the focus is only caught when main sends `visibleDistraction` (a catalog service visible and playing on any display) and the input is idle for 10 s. Without it the second monitor reads as a screen and the video gets full focus credit. A video watched while typing in the notes is not caught.
- The generic classifier keeps the session's opening pose (the first 20 s of calm frames) as a screen. A user who starts by looking elsewhere without touching the keyboard teaches it that direction until three other screens displace it.
- The pitch sign must be checked once by hand in the demo, on a real face.

## Appendix: how A and B were merged

| Topic                                                                    | Taken from | Why                                                                                              |
| ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| Structured `FrameFeatures` + absolute 22-column rows                     | A          | readable and testable; rows re-derive with a new baseline                                        |
| Quantising rows at record time                                           | B          | exact JSON round trip, identical retrain                                                         |
| Forward-vector pose, degrees, layout auto-detect                         | A          | no gimbal or decomposition-order bugs                                                            |
| `numFaces: 2` with user-face selection                                   | A          | a person behind the user never takes over                                                        |
| Baseline-relative features + RBF anchors, CV λ, trust π, augmentation    | A          | handles an off-axis camera and a second monitor; the phone/reading ambiguity is learned per user |
| Learned `thresholds.phone`; `absent` clip calibrates `thresholds.person` | B + new    | absorbs a calculator or a coat on the chair                                                      |
| Pitch-compensated blink fit + eyes reliability                           | A          | reading lowers the eyelids; glasses                                                              |
| Floor = min(95, θ+20) for looking down and book                          | B          | stays above θ + H at every sensitivity (A's 0.75 failed at θ = 80)                               |
| F_dist discounts only p.screen                                           | A          | «aunque mires la pantalla»; a notebook with music stays study                                    |
| Weak +0.10 input bonus                                                   | B          | the brief calls it a weak signal                                                                 |
| Hidden face decided by the last visible pose                             | B          | writing head down vs. turned around                                                              |
| Absence accumulator reset only after 10 s present                        | B          | anti-trick                                                                                       |
| Covered camera via luma + camera lost fails closed                       | A + B      | faster, explicit hints, never an exploit                                                         |
| Absence warning at noFace/2                                              | A          | a sound before the strike                                                                        |
| Time-weighted windows, quality weights, fast recovery                    | A + B      | fps-independent, quick doubt clearing                                                            |
| Grace as a flag (not a state) + guardian cooldown extension              | B + A      | simpler UI states; stays in sync with the guardian                                               |
| Cumulative totals, deltas in main, `runId`                               | A + new    | robust to lost IPC and window restarts                                                           |
| Segment timeline + bucketizer                                            | A + B      | compact storage, simple summary line                                                             |
| Discrete governor levels                                                 | B          | testable; A's cpuProbe kept                                                                      |
| `ImageCapture.grabFrame()` + `<video>` fallback                          | B          | available in `lib.dom`, independent of visibility                                                |
| Camera off during breaks                                                 | B          | «la cámara no vigila» is literally true                                                          |
| Network lockdown of the analysis window                                  | B          | the verified MediaPipe logger                                                                    |
| Calibration in the hidden window, preview in the visible one             | new        | MediaPipe in one locked-down place; no frames over IPC                                           |
| Two entry points, the pure one typechecked without DOM                   | A + new    | Electron main imports the pure entry                                                             |
