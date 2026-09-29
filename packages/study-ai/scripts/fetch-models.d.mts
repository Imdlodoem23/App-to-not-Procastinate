/** Types of fetch-models.mjs, for the tests that import it. */

export interface ExpectedFile {
  sha256: string;
  bytes: number;
}

export interface ModelsManifest {
  $comment: string;
  format: 'centrate-study-ai-models';
  version: 1;
  models: {
    id: string;
    name: string;
    file: string;
    url: string;
    sha256: string;
    bytes: number;
    license: string;
  }[];
  wasm: {
    package: string;
    version: string;
    dir: string;
    committed: boolean;
    files: ({ file: string } & ExpectedFile)[];
  };
}

export function buildManifest(): ModelsManifest;

export function manifestText(): string;
export function sha256(bytes: Uint8Array): string;
/** `null` when `bytes` match, otherwise what is wrong. */
export function mismatch(bytes: Uint8Array, expected: ExpectedFile): string | null;
/** Runs the script with these arguments and returns its exit code. */
export function run(argv: string[]): Promise<number>;
