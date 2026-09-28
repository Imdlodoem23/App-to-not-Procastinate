# @centrate/study-ai

La IA del Study Mode de Céntrate: mira la cámara (o, sin cámara, la app en primer plano y el teclado) y decide cuándo avisarte y cuándo pedir un strike al guardián. Todo ocurre en tu ordenador.

## Resumen (para ti)

### Qué hace

- **Mira unas 3 veces por segundo** a baja resolución (320×240): si hay una cara, hacia dónde mira la cabeza, si los ojos llevan mucho rato cerrados, y si en la imagen hay un móvil, un libro o una persona.
- **Calcula una puntuación de concentración** de 0 a 100, suavizada con la media de los últimos 15 s (configurable entre 10 y 20 s). Así un vistazo al techo no cuenta.
- **Máquina de estados** (los tiempos se cambian en Ajustes):
  - **Enfocado:** todo bien.
  - **Duda:** la puntuación lleva 15 s por debajo del umbral. Suena un aviso suave y aparece «¿Sigues ahí?».
  - **Strike:** siguen 30 s más en duda. El guardián decide si cuenta y resta −15 puntos. Después hay 60 s de margen.
  - **«No te veo»:** no hay nadie (o la cámara está tapada). A los 30 s suena un aviso y a los 60 s hay strike.
  - **Descansos del Pomodoro y «Pausa»:** no cuentan y la cámara se apaga.

### Qué no castiga

- **Mirar hacia abajo para escribir o leer es estudiar.** Solo cambia si ve un móvil en tu mano.
- **Un libro** en la imagen suma.
- **Los ojos cerrados** mucho rato no dan strike: te sugieren un descanso.
- **Una app de distracción en primer plano** solo cuenta si estás mirando la pantalla. Si escribes en tu cuaderno con música puesta, sigues estudiando.

### Tu IA personal

- La primera vez grabas 5 situaciones de unos 20 s cada una:
  - estudiando mirando la pantalla;
  - estudiando con libro o cuaderno;
  - con el móvil;
  - mirando a otro lado;
  - sin estar.
- Con eso se entrena en tu ordenador un clasificador pequeño, hecho a tu medida (tu cámara, tu postura, tu segunda pantalla).
- Puedes recalibrar cuando quieras.
- Si la IA se equivoca, pulsa **«¡Estaba estudiando!»**: guarda ese momento como ejemplo y aprende de él. No devuelve un strike que ya ha contado; eso lo decide el guardián.

### Sin cámara

Usa solo la app o web en primer plano y si tocas el teclado o el ratón. Si estás en una distracción, o llevas mucho rato sin tocar nada (8 min por defecto), te pregunta «¿Sigues ahí?».

### Privacidad

- **Ninguna imagen se guarda, se sube ni sale del proceso.** De cada fotograma solo salen números (ángulos, probabilidades), y el fotograma se libera al momento.
- **Solo se guarda `profile.json`**, con los números de la calibración, en la carpeta de datos de la app. «Borrar todos mis datos» lo elimina.
- **La ventana que analiza la cámara no tiene acceso a internet.** La librería MediaPipe intenta enviar estadísticas de uso a Google y Céntrate lo bloquea.
- **Gasta menos del 15 % de CPU:** si tu ordenador va justo, baja sola a 2 fotogramas por segundo.

## Estado

Diseño cerrado en [DESIGN.md](DESIGN.md). Los módulos marcados como _stub_ lanzan `not implemented` hasta que su equipo los termine (ver DESIGN.md §4). La integración en la app de escritorio se documentará en `HANDOFF.md`.

---

## API (English)

Full specification: [DESIGN.md](DESIGN.md). Contract: [`src/types.ts`](src/types.ts).

### Entry points

| Import                       | Where                                      | What                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@centrate/study-ai`         | anywhere (Electron main, renderer, Node)   | Types, settings, asset constants, `FeatureExtractor`, classifiers, calibration and profile, observers, `AttentionEngine`, `CpuGovernor`, `AdaptiveLoop`, `HeartbeatAccumulator`, IPC guards. DOM-free. |
| `@centrate/study-ai/runtime` | renderer only (the hidden analysis window) | All of the above, plus `openCamera`, `createVisionPipeline`, `startStudySession`, `startCalibration`, `createAnalysisHost`.                                                                            |

### Hidden analysis window (renderer)

```ts
import { ANALYSIS_ASSETS, createAnalysisHost } from '@centrate/study-ai/runtime';

// `bridge` is the window's preload API (post/onMessage only).
const host = createAnalysisHost({ post: (m) => bridge.post(m), assets: ANALYSIS_ASSETS });
bridge.onMessage((m) => host.handle(m)); // AnalysisInbound, validated inside
```

**Messages:**

- **main → window** (`AnalysisInbound`): `session_start`, `context` (1 Hz: phase, foreground class, idle ms), `settings`, `strike_result`, `studying_feedback`, `continue_without_camera`, `resume`, `session_stop`, `calibration_*`.
- **window → main** (`AnalysisOutbound`):
  - `event`: `warning`, `strike`, `suggest_break`, `hint`, `state`, `profile_updated`, `camera`, `mode`;
  - `report` (1 Hz, cumulative totals);
  - `feedback_result`, `session_stopped`, `calibration_progress`, `calibration_recorded`, `calibration_built`, `error`.

### Electron main

```ts
import { HeartbeatAccumulator, isAnalysisOutbound } from '@centrate/study-ai';

const heartbeats = new HeartbeatAccumulator();
onAnalysisMessage((m) => {
  if (!isAnalysisOutbound(m)) return;
  if (m.type === 'report') heartbeats.report(m.report, performance.now());
  if (m.type === 'event' && m.event.type === 'strike') postStrike(m.event.cause, m.event.seq);
});
setInterval(() => {
  const body = heartbeats.take(performance.now()); // null → analysis loop dead: stop heartbeating
  if (body) postHeartbeat({ seq: nextSeq(), ...body });
}, 15_000);
```

### Main building blocks

| Symbol                                                                     | Owner      | Purpose                                                                                |
| -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `resolveStudyAiSettings(partial)`                                          | lead       | Clamps timings and sensitivity to `STUDY_RULES` (+ `focusWindowMs`, `noCameraIdleMs`). |
| `STUDY_AI_CONSTANTS`                                                       | lead       | Cross-module constants (hysteresis, warm-up, grace, feedback limits…).                 |
| `MODEL_MANIFEST`, `ANALYSIS_ASSETS`, `isAllowedAssetUrl`                   | PERCEPTION | Pinned offline models, local asset URLs, the local-only URL rule.                      |
| `createVisionPipeline`, `openCamera`, `FeatureExtractor`, `poseFromMatrix` | PERCEPTION | Camera frames → `FrameFeatures` (numbers only).                                        |
| `CalibrationRecorder`, `buildProfile`, `parseProfile`, `serializeProfile`  | LEARNING   | 5-situation calibration → `CalibrationProfile` (softmax, CV).                          |
| `createPersonalClassifier`, `createGenericClassifier`, `learnFromFeedback` | LEARNING   | Class probabilities per frame; «¡Estaba estudiando!» retraining.                       |
| `CameraObserver`, `AttentionEngine`, `heartbeatState`, `bucketizeTimeline` | DECISION   | Fusion rules, smoothing, hysteresis, ENFOCADO → DUDA → STRIKE, totals, timeline.       |
| `NoCameraObserver`, `CpuGovernor`, `AdaptiveLoop`                          | RUNTIME    | No-camera mode, CPU budget, setTimeout loop.                                           |
| `startStudySession`, `startCalibration`, `createAnalysisHost`              | RUNTIME    | Facades that wire everything and speak the IPC contract.                               |
| `HeartbeatAccumulator`                                                     | RUNTIME    | Main-side deltas for the 15 s heartbeat; dead-loop detection.                          |

### Commands

```sh
npm run typecheck -w packages/study-ai   # tsconfig.json + tsconfig.pure.json (DOM-free entry)
npm test -w packages/study-ai            # vitest in Node (synthetic numeric streams, no WASM)
npx eslint packages/study-ai
npm run demo -w packages/study-ai        # Vite page with the real webcam (127.0.0.1)
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser -w packages/study-ai
npm run fetch-models -w packages/study-ai -- --check
```
