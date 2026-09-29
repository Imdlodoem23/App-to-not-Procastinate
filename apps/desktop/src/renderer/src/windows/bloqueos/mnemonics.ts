/**
 * Alt + letter for the tiles of the detail windows (PROMPT §10 «Alt + letra en cada tile, como
 * en G-Helper»), pure. Every tile gets a key that is unique within its window: fixed tiles have
 * fixed letters (chosen from their label, so the letter is underlined while Alt is held), and
 * tiles that repeat per row (templates, extension guides, exam presets) are given the first free
 * character of their label, else the first free letter or digit. A window has 36 keys; a tile
 * past that gets none.
 */

/** Keys `mnemonicFromCode` can produce: letters, then digits. */
export const MNEMONIC_KEYS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function fold(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * One key per label, in order, never one of `taken` nor one given to an earlier label: the first
 * character of the label that is free (so it can be underlined), else the first free key, else
 * `undefined`.
 */
export function allocateMnemonics(
  labels: readonly string[],
  taken: Iterable<string>,
): (string | undefined)[] {
  const used = new Set<string>();
  for (const key of taken) used.add(key.toLowerCase());
  return labels.map((label) => {
    const own = Array.from(label)
      .map(fold)
      .find((c) => c.length === 1 && MNEMONIC_KEYS.includes(c) && !used.has(c));
    const key = own ?? Array.from(MNEMONIC_KEYS).find((c) => !used.has(c));
    if (key) used.add(key);
    return key;
  });
}

/** Keys that appear more than once (a window must have none). */
export function duplicateKeys(keys: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const key of keys) {
    if (!key) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}
