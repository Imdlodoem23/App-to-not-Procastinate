/**
 * Alt + letter accelerators (G-Helper style): the letter is underlined in the label while Alt is
 * held. Pure: where the mnemonic sits in a label.
 */

export interface MnemonicSplit {
  before: string;
  key: string;
  after: string;
}

function fold(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The first character of `label` that matches `mnemonic` (case- and accent-insensitive, so
 * «á» carries «a»), or `null` when the label does not contain it (the key still works; nothing
 * is underlined).
 */
export function splitMnemonic(label: string, mnemonic: string | undefined): MnemonicSplit | null {
  if (!mnemonic) return null;
  const target = fold(mnemonic);
  if (target.length !== 1) return null;
  const chars = Array.from(label);
  const index = chars.findIndex((c) => fold(c) === target);
  if (index < 0) return null;
  return {
    before: chars.slice(0, index).join(''),
    key: chars[index] ?? '',
    after: chars.slice(index + 1).join(''),
  };
}
