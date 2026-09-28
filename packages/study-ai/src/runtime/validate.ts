/**
 * Tiny strict validators for the IPC guards (owner: RUNTIME). Pure and DOM-free.
 * Objects must be plain, with exactly the declared keys (optional ones may be missing);
 * numbers must be finite; strings and arrays are length-capped.
 */

export type Check = (value: unknown) => boolean;

const OPTIONAL = Symbol('optional');
type OptionalCheck = Check & { [OPTIONAL]: true };

export function optional(check: Check): Check {
  const wrapped = ((value: unknown) => check(value)) as OptionalCheck;
  wrapped[OPTIONAL] = true;
  return wrapped;
}

const isOptional = (check: Check): boolean => (check as Partial<OptionalCheck>)[OPTIONAL] === true;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A plain object with exactly these keys (optional ones may be absent, never extra ones). */
export function exact(shape: Readonly<Record<string, Check>>): Check {
  const keys = Object.keys(shape);
  return (value) => {
    if (!isPlainObject(value)) return false;
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) return false;
    }
    for (const key of keys) {
      const check = shape[key] as Check;
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        if (isOptional(check)) continue;
        return false;
      }
      if (!check(value[key])) return false;
    }
    return true;
  };
}

export const bool: Check = (value) => typeof value === 'boolean';

export const finite: Check = (value) => typeof value === 'number' && Number.isFinite(value);

export function num(min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): Check {
  return (value) => finite(value) && (value as number) >= min && (value as number) <= max;
}

export function int(min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): Check {
  return (value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function str(maxLength: number, pattern?: RegExp): Check {
  return (value) =>
    typeof value === 'string' &&
    value.length <= maxLength &&
    (pattern === undefined || pattern.test(value));
}

export function literal(...allowed: readonly (string | number | boolean | null)[]): Check {
  const set = new Set<unknown>(allowed);
  return (value) => set.has(value);
}

export function oneOf(values: readonly string[]): Check {
  const set = new Set<unknown>(values);
  return (value) => set.has(value);
}

export function nullable(check: Check): Check {
  return (value) => value === null || check(value);
}

export function array(check: Check, maxLength: number, minLength = 0): Check {
  return (value) =>
    Array.isArray(value) &&
    value.length >= minLength &&
    value.length <= maxLength &&
    value.every((item) => check(item));
}

/** Exactly these elements, in order. */
export function tuple(...checks: readonly Check[]): Check {
  return (value) =>
    Array.isArray(value) &&
    value.length === checks.length &&
    checks.every((check, i) => check(value[i]));
}

/** Discriminated union on `type` (or another key). */
export function tagged(variants: Readonly<Record<string, Check>>, key: string = 'type'): Check {
  return (value) => {
    if (!isPlainObject(value)) return false;
    const tag = value[key];
    if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(variants, tag)) {
      return false;
    }
    return (variants[tag] as Check)(value);
  };
}

export function anyOf(...checks: readonly Check[]): Check {
  return (value) => checks.some((check) => check(value));
}
