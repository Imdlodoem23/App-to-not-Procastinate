/**
 * Friend invite codes (docs/API.md §8.1): 10 Crockford base32 characters (50 bits), shown as
 * `XXXXX-XXXXX`. The server stores only the SHA-256 of the normalized code, so a database
 * leak does not reveal usable codes.
 */
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { createHash, randomInt } from 'node:crypto';

/** Crockford base32: digits and upper-case letters without I, L, O and U. */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CODE_RE = new RegExp(`^[${INVITE_ALPHABET}]{${CLOUD_LIMITS.inviteCodeLength}}$`);

/** A new random code, normalized (no dash). */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < CLOUD_LIMITS.inviteCodeLength; i += 1) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return code;
}

/**
 * Normalizes what a person typed or a link carried: upper case, no dashes or spaces, and the
 * Crockford look-alikes `I`/`L` → `1`, `O` → `0`. Null when it cannot be a code.
 */
export function normalizeInviteCode(input: string): string | null {
  if (input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE_RE.test(code) ? code : null;
}

/** `ABCDEFGHJK` → `ABCDE-FGHJK`. */
export function formatInviteCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** SHA-256 (hex) of a normalized code: the only form the database keeps. */
export function hashInviteCode(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
