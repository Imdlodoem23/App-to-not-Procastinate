/**
 * The hidden analysis window's page script (HANDOFF §1.4), for the browser smoke test. It
 * imports the renderer entry like the app does; `window.__analysis` stands in for the preload
 * bridge: `send()` is main's `analysis:in`, and `messages` keeps what the host posts
 * (`analysis:out`) after the same `isAnalysisOutbound` check main runs.
 */
import { createAnalysisHost, isAnalysisOutbound } from '../src/runtime';
import type { AnalysisOutbound, ContextInput, VisionAssets } from '../src/runtime';

/** This loopback server serves the files `centrate-ai://assets/…` serves in the app. */
const ASSETS: VisionAssets = {
  wasmBaseUrl: `${location.origin}/mediapipe`,
  faceModel: { url: `${location.origin}/models/face_landmarker.task` },
  objectModel: { url: `${location.origin}/models/efficientdet_lite0_int8.tflite` },
};

interface AnalysisProbe {
  /** Everything the host posted that main's guard accepted (reports trimmed to the last 60). */
  messages: AnalysisOutbound[];
  /** Messages main's guard would have dropped. */
  invalid: number;
  /** `directive blockedURI` of every CSP violation on this page. */
  blocked: string[];
  send(message: unknown): void;
  /** Plays main's 1 Hz `context` message. */
  keepContext(context: ContextInput | null): void;
  dispose(): Promise<void>;
}

let contextTimer: ReturnType<typeof setInterval> | null = null;
const reports: AnalysisOutbound[] = [];

const probe: AnalysisProbe = {
  messages: [],
  invalid: 0,
  blocked: [],
  send: (message) => host.handle(message),
  keepContext: (context) => {
    if (contextTimer !== null) clearInterval(contextTimer);
    contextTimer = null;
    if (context === null) return;
    host.handle({ type: 'context', context });
    contextTimer = setInterval(() => host.handle({ type: 'context', context }), 1_000);
  },
  dispose: () => host.dispose(),
};

const host = createAnalysisHost({
  post: (message) => {
    if (!isAnalysisOutbound(message)) {
      probe.invalid += 1;
      return;
    }
    probe.messages.push(message);
    if (message.type === 'report') reports.push(message);
    const oldest = reports.length > 60 ? reports.shift() : undefined;
    if (oldest !== undefined) probe.messages.splice(probe.messages.indexOf(oldest), 1);
  },
  assets: ASSETS,
});

document.addEventListener('securitypolicyviolation', (event) => {
  probe.blocked.push(`${event.effectiveDirective} ${event.blockedURI}`);
});
window.addEventListener('pagehide', () => void host.dispose());
(window as unknown as { __analysis: AnalysisProbe }).__analysis = probe;
