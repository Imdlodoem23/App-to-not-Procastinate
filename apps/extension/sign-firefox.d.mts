// Types of sign-firefox.mjs (plain Node for the release job, typed for
// test/build/sign-firefox.test.ts).
export type Env = Record<string, string | undefined>;

export interface Credentials {
  issuer: string;
  secret: string;
}

export interface SignCommand {
  /** Always process.execPath: web-ext's bin runs on this Node, without npx or a shell. */
  file: string;
  args: string[];
  options: { stdio: 'inherit'; env: Env };
}

export type Exec = (file: string, args: string[], options: SignCommand['options']) => unknown;

export interface SignFirefoxOptions {
  /** Directory holding dist/ and release/ (default: process.cwd()). */
  cwd?: string;
  env?: Env;
  /** Locates web-ext's bin (default: findWebExtBin from this script's directory). */
  findBin?: () => string | null;
  exec?: Exec;
  log?: (message: string) => void;
}

export declare function findWebExtBin(fromDir: string): string | null;
export declare function signArgs(sourceDir: string, artifactsDir: string): string[];
export declare function signEnv(baseEnv: Env, credentials: Credentials): Env;
export declare function signCommand(input: {
  bin: string;
  sourceDir: string;
  artifactsDir: string;
  env: Env;
  credentials: Credentials;
}): SignCommand;
export declare function signFirefox(options?: SignFirefoxOptions): 'signed' | 'skipped';
