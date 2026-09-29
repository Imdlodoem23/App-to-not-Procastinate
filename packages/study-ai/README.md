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
- **Un vídeo en la segunda pantalla** mientras tus apuntes tienen el foco cuenta como distracción solo si no tocas el teclado ni el ratón durante 10 s: si escribes en el ordenador o en papel, sigues estudiando.

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

Si la cámara falla al empezar (otra app la está usando, está desenchufada), la sesión sigue sin cámara y lo vuelve a intentar sola cada poco; «Seguir sin cámara» deja de intentarlo.

### Privacidad

- **Ninguna imagen se guarda, se sube ni sale del proceso.** De cada fotograma solo salen números y el fotograma se libera al momento.
- **Solo se guarda `profile.json`**, en la carpeta de datos de la app. Son números, nunca imágenes, pero son medidas de tu cara y de tu postura, fotograma a fotograma:
  - **De la calibración:** hasta 80 fotogramas de cada situación.
  - **De cada «¡Estaba estudiando!»:** hasta 30 fotogramas de ese momento de la sesión. Se guardan los 300 más recientes de cada situación de estudio (pantalla, y libro o cuaderno) y la fecha del último.
  - **De cada fotograma, 22 números:** si hay cara; los ángulos de la cabeza; la posición y el tamaño de la cara en la imagen, y cuánto queda cortada por el borde; el parpadeo, la mirada (hacia abajo, hacia arriba y a los lados) y cuánto abres la boca; el brillo y el contraste de la habitación; la calidad de la imagen; y lo que ven los detectores: la probabilidad de un móvil (y si está cerca de la cara o se mueve), de un libro y de una persona.
  - **Lo que la IA aprende de ellos:** tu postura de referencia, los umbrales, el modelo, la fecha de cada grabación y una huella (hash) del nombre y la resolución de la cámara, para saber si es la misma.
  - El archivo nunca pasa de 5000 filas ni de 512 KB.
- **«Recalibrar»** vuelve a grabar las 5 situaciones y borra también los momentos de «¡Estaba estudiando!». **«Borrar todos mis datos»** elimina el archivo.
- **La ventana que analiza la cámara no tiene acceso a internet.** La librería MediaPipe intenta enviar estadísticas de uso a Google y Céntrate lo bloquea.
- **Gasta menos del 15 % de CPU:** si tu ordenador va justo, baja sola a 2 fotogramas por segundo y busca el móvil con menos frecuencia (salvo cuando acaba de ver uno). En un ordenador muy lento analiza aún menos fotogramas antes que pasarse del 15 %.

## Estado

Todos los módulos están implementados y probados en Node (y en Chromium con `npm run test:browser`). El diseño está en [DESIGN.md](DESIGN.md); **la integración en la app de escritorio (ventana oculta, IPC, latidos, strikes, interfaz) está en [HANDOFF.md](HANDOFF.md), que manda sobre DESIGN.md en todo lo que toca a la integración.**

---

## API (English)

Design: [DESIGN.md](DESIGN.md). Contract: [`src/types.ts`](src/types.ts). **Integration (the
authoritative spec for the desktop): [HANDOFF.md](HANDOFF.md).**

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

- **main → window** (`AnalysisInbound`): `session_start` (with a camera **label**, never a `deviceId`: HANDOFF §3.1), `context` (1 Hz: phase, foreground class, idle ms, optional `visibleDistraction`), `settings`, `strike_result`, `studying_feedback`, `continue_without_camera`, `resume`, `session_stop`, `calibration_*`, `list_cameras`.
- **window → main** (`AnalysisOutbound`):
  - `event`: `warning`, `strike`, `suggest_break`, `hint`, `state`, `profile_updated`, `camera`, `mode`;
  - `report` (1 Hz, cumulative totals);
  - `feedback_result`, `session_stopped`, `calibration_progress`, `calibration_recorded`, `calibration_built`, `cameras`, `error`.

### Electron main

Follow [HANDOFF.md §4](HANDOFF.md#4-main-loop-during-a-session): heartbeats and strikes must
be **exactly once**, and the naive loop (a new body and a new `seq` on every tick, a strike
POST without a key) loses focus time or counts it twice when a request fails, and turns a
retried strike into a second −15. In short:

```ts
import { HeartbeatAccumulator, isAnalysisOutbound } from '@centrate/study-ai';

const acc = new HeartbeatAccumulator();
let seq = session.lastHeartbeatSeq; // continue the guardian's seq, never restart at 0
let pending: HeartbeatRequest | null = null; // sent but not answered: resent UNCHANGED

onAnalysisMessage((m) => {
  if (!isAnalysisOutbound(m)) return;
  if (m.type === 'report') acc.report(m.report, performance.now());
  if (m.type === 'event' && m.event.type === 'strike') {
    // Retried with the same key and body until the guardian answers (HANDOFF §4).
    postStrike(m.event.cause, { idempotencyKey: `${sessionId}:${runId}:${m.event.seq}` });
  }
});

async function heartbeat(): Promise<void> {
  if (pending === null) {
    const body = acc.take(performance.now()); // null → analysis loop dead: stop heartbeating
    if (body === null) return;
    pending = { seq: seq + 1, ...body };
  }
  const res = await guardian.studyHeartbeat(sessionId, pending); // on failure: keep `pending`
  seq = Math.max(pending.seq, res.session.lastHeartbeatSeq);
  pending = null;
}
```

### Main building blocks

| Symbol                                                                     | Owner      | Purpose                                                                                |
| -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `resolveStudyAiSettings(partial)`                                          | lead       | Clamps timings and sensitivity to `STUDY_RULES` (+ `focusWindowMs`, `noCameraIdleMs`). |
| `STUDY_AI_CONSTANTS`                                                       | lead       | Cross-module constants (hysteresis, warm-up, grace, feedback limits…).                 |
| `MODEL_MANIFEST`, `ANALYSIS_ASSETS`, `isAllowedAssetUrl`                   | PERCEPTION | Pinned offline models, local asset URLs, the local-only URL rule.                      |
| `createVisionPipeline`, `openCamera`, `FeatureExtractor`, `poseFromMatrix` | PERCEPTION | Camera frames → `FrameFeatures` (numbers only).                                        |
| `CalibrationRecorder`, `buildProfile`, `parseProfile`, `serializeProfile`  | LEARNING   | 5-situation calibration → `CalibrationProfile` (softmax, CV).                          |
| `profileStatus`, `calibrationSteps`, `nextPendingSituation`                | LEARNING   | Wizard rows and «calibrado» header in main, from the JSON, without retraining.         |
| `createPersonalClassifier`, `createGenericClassifier`, `learnFromFeedback` | LEARNING   | Class probabilities per frame; «¡Estaba estudiando!» retraining.                       |
| `CameraObserver`, `AttentionEngine`, `heartbeatState`, `bucketizeTimeline` | DECISION   | Fusion rules, smoothing, hysteresis, ENFOCADO → DUDA → STRIKE, totals, timeline.       |
| `NoCameraObserver`, `CpuGovernor`, `AdaptiveLoop`                          | RUNTIME    | No-camera mode, CPU budget (hard 15 % duty cap), setTimeout loop.                      |
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
