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

const EN_UNITS: ReadonlyMap<string, number> = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
]);

const EN_TEENS: ReadonlyMap<string, number> = new Map([
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
]);

const EN_TENS: ReadonlyMap<string, number> = new Map([
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fourty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

/** Every word that can be part of a number, for callers that skip known words. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...UNITS.keys(),
  ...TEENS.keys(),
  ...TENS.keys(),
  ...HUNDREDS.keys(),
  ...EN_UNITS.keys(),
  ...EN_TEENS.keys(),
  ...EN_TENS.keys(),
  'par',
  'couple',
]);

export interface NumberMatch {
  readonly value: number;
  /** Index after the last token of the number. */
  readonly end: number;
}

/**
 * An English number written in words starting at `tokens[k]`, from «one» to «ninety-nine»:
 * «one», «fifteen», «forty-five», «forty five» (a hyphen does not split tokens apart).
 */
function parseEnglishWordNumber(tokens: readonly Token[], k: number): NumberMatch | null {
  const word = normAt(tokens, k);
  const ten = EN_TENS.get(word);
  if (ten !== undefined) {
    const unit = EN_UNITS.get(nextNorm(tokens, k + 1));
    return unit === undefined ? { value: ten, end: k + 1 } : { value: ten + unit, end: k + 2 };
  }
  const small = EN_TEENS.get(word) ?? EN_UNITS.get(word);
  return small === undefined ? null : { value: small, end: k + 1 };
}

/**
 * A number written in words starting at `tokens[k]`: Spanish from «cero» to «novecientos
 * noventa y nueve» («una», «quince», «cuarenta y cinco», «ciento veinte») or English from
 * «one» to «ninety-nine».
 */
export function parseWordNumber(tokens: readonly Token[], k: number): NumberMatch | null {
  const english = parseEnglishWordNumber(tokens, k);
  if (english) return english;
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
 * An amount starting at `tokens[k]`: digits («90»), a decimal («1,5»), «par de», «couple
 * (of)» or a number in words. Digits are capped at six so durations stay far from Date
 * limits.
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
  if (token.norm === 'couple') {
    return { value: 2, end: nextNorm(tokens, k + 1) === 'of' ? k + 2 : k + 1 };
  }
  return parseWordNumber(tokens, k);
}
