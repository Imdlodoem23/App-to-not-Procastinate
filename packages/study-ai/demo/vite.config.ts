/**
 * Manual-test page for @centrate/study-ai (`npm run demo -w packages/study-ai`).
 *
 * Loopback only. A tiny middleware serves the offline assets the analysis window gets through
 * `centrate-ai://` in the app:
 * - `/mediapipe/vision_wasm_internal.{js,wasm}` from `@mediapipe/tasks-vision/wasm`;
 * - `/models/<file>` for the two files of `MODEL_MANIFEST`, from `apps/desktop/resources/models`
 *   (committed; `npm run fetch-models -w packages/study-ai -- --check` verifies them);
 * - `/tokens.css`, the shared design tokens.
 * Nothing else is served from outside `demo/`, and the page's CSP blocks every other host
 * (including MediaPipe's usage logger).
 */
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { MEDIAPIPE_WASM_FILES, MODELS_DIR, MODEL_MANIFEST } from '../src/assets';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const modelsDir = join(repo, MODELS_DIR);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
};

/** URL path → file on disk; a fixed allowlist, so no traversal is possible. */
const FILES: ReadonlyMap<string, string> = new Map<string, string>([
  ...MEDIAPIPE_WASM_FILES.map((file): [string, string] => [
    `/mediapipe/${file}`,
    join(wasmDir, file),
  ]),
  ...MODEL_MANIFEST.map((m): [string, string] => [`/models/${m.file}`, join(modelsDir, m.file)]),
  ['/tokens.css', join(repo, 'packages/shared/src/design/tokens.css')],
]);

function serveFile(res: ServerResponse, file: string): void {
  const ext = file.slice(file.lastIndexOf('.'));
  const size = statSync(file).size;
  res.statusCode = 200;
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(file).pipe(res);
}

function localAssets(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const file = FILES.get(path);
    if (file === undefined) {
      if (path.startsWith('/mediapipe/') || path.startsWith('/models/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      next();
      return;
    }
    try {
      serveFile(res, file);
    } catch {
      res.statusCode = 404;
      res.end(`missing ${path}: run npm run fetch-models -w packages/study-ai`);
    }
  };
  return {
    name: 'centrate-study-ai-local-assets',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

const port = Number(process.env.STUDY_AI_DEMO_PORT ?? 5199);
/** The smoke test turns HMR off: an edited source file must not reload the page mid-session. */
const stable = process.env.STUDY_AI_DEMO_STABLE === '1';

export default defineConfig({
  root: here,
  clearScreen: false,
  plugins: [localAssets()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    ...(stable ? { hmr: false, watch: null } : {}),
  },
  preview: { host: '127.0.0.1', port, strictPort: true },
  optimizeDeps: {
    // Pre-bundled at start, and no discovery at runtime: a late discovery would reload the
    // page in the middle of a session.
    include: ['@mediapipe/tasks-vision'],
    noDiscovery: true,
  },
});
