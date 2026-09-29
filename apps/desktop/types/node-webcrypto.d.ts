// `@centrate/shared/guardian-api` names the Web Crypto `CryptoKey` type, which only the DOM lib
// declares. Main-process code (Node types, no DOM lib) gets it from Node's webcrypto instead.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
}
