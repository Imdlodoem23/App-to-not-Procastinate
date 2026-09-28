// Types of manifest.mjs (plain Node for build.mjs, typed for test/build/manifest.test.ts).
export type Engine = 'chromium' | 'firefox';
export declare const ENGINES: readonly Engine[];
export declare function isEngine(value: unknown): value is Engine;
export declare function manifestFor(
  manifest: Record<string, unknown>,
  engine: Engine,
): Record<string, unknown>;
