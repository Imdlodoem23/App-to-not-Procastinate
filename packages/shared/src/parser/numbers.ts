import { nextNorm, normAt, type Token } from './text';

const UNITS: ReadonlyMap<string, number> = new Map([
  ['cero', 0],
  ['un', 1],
  ['uno', 1],
  ['una', 1],
  ['dos', 2],
  ['tres', 3],
  ['cuatro', 4],
  ['cinco', 5],
  ['seis', 6],
  ['siete', 7],
  ['ocho', 8],
  ['nueve', 9],
]);

const TEENS: ReadonlyMap<string, number> = new Map([
  ['diez', 10],
  ['once', 11],
  ['doce', 12],
  ['trece', 13],
  ['catorce', 14],
  ['quince', 15],
  ['dieciseis', 16],
  ['diecisiete', 17],
  ['dieciocho', 18],
  ['diecinueve', 19],
  ['veinte', 20],
  ['veintiun', 21],
  ['veintiuno', 21],
  ['veintiuna', 21],
  ['veintidos', 22],
  ['veintitres', 23],
  ['veinticuatro', 24],
  ['veinticinco', 25],
  ['veintiseis', 26],
  ['veintisiete', 27],
  ['veintiocho', 28],
  ['veintinueve', 29],
]);

const TENS: ReadonlyMap<string, number> = new Map([
  ['treinta', 30],
  ['cuarenta', 40],
  ['cincuenta', 50],
  ['sesenta', 60],
  ['setenta', 70],
  ['ochenta', 80],
  ['noventa', 90],
]);

const HUNDREDS: ReadonlyMap<string, number> = new Map([
  ['cien', 100],
  ['ciento', 100],
  ['doscientos', 200],
  ['doscientas', 200],
  ['trescientos', 300],
  ['trescientas', 300],
  ['cuatrocientos', 400],
  ['cuatrocientas', 400],
  ['quinientos', 500],
  ['quinientas', 500],
  ['seiscientos', 600],
  ['seiscientas', 600],
  ['setecientos', 700],
  ['setecientas', 700],
  ['ochocientos', 800],
  ['ochocientas', 800],
  ['novecientos', 900],
  ['novecientas', 900],
]);

/** Every word that can be part of a number, for callers that skip known words. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...UNITS.keys(),
  ...TEENS.keys(),
  ...TENS.keys(),
  ...HUNDREDS.keys(),
  'par',
]);

export interface NumberMatch {
  readonly value: number;
  /** Index after the last token of the number. */
  readonly end: number;
}

/**
 * A Spanish number written in words starting at `tokens[k]`, from «cero» to
 * «novecientos noventa y nueve»: «una», «quince», «cuarenta y cinco», «ciento veinte».
 */
export function parseWordNumber(tokens: readonly Token[], k: number): NumberMatch | null {
  let j = k;
  let value = 0;
  let found = false;
  let word = normAt(tokens, j);
  const hundred = HUNDREDS.get(word);
  if (hundred !== undefined) {
    value += hundred;
    j += 1;
    found = true;
    if (word === 'cien') return { value, end: j };
    word = nextNorm(tokens, j);
  }
  const ten = TENS.get(word);
  if (ten !== undefined) {
    value += ten;
    j += 1;
    const unit = UNITS.get(nextNorm(tokens, j + 1));
    if (nextNorm(tokens, j) === 'y' && unit !== undefined && unit > 0) {
      value += unit;
      j += 2;
    }
    return { value, end: j };
  }
  const small = TEENS.get(word) ?? UNITS.get(word);
  if (small !== undefined) {
    value += small;
    j += 1;
    found = true;
  }
  return found ? { value, end: j } : null;
}

const INTEGER_RE = /^\d{1,6}$/;
const DECIMAL_RE = /^(\d{1,4})[.,](\d{1,2})$/;

/**
 * An amount starting at `tokens[k]`: digits («90»), a decimal («1,5»), «par de» or a
 * number in words. Digits are capped at six so durations stay far from Date limits.
 */
export function parseAmount(tokens: readonly Token[], k: number): NumberMatch | null {
  const token = tokens[k];
  if (!token) return null;
  if (token.type === 'num') {
    if (INTEGER_RE.test(token.norm)) return { value: Number(token.norm), end: k + 1 };
    const decimal = DECIMAL_RE.exec(token.norm);
    if (decimal) return { value: Number(`${decimal[1]}.${decimal[2]}`), end: k + 1 };
    return null;
  }
  if (token.norm === 'par' && nextNorm(tokens, k + 1) === 'de') return { value: 2, end: k + 2 };
  return parseWordNumber(tokens, k);
}
