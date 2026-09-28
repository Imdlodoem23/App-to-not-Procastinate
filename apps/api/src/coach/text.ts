/**
 * Text hygiene for the coach (owner: COACH): what goes into a prompt and what comes back out.
 * Pure functions, no I/O.
 */

// C0/C1 controls, bidi overrides and zero-width characters.
const CONTROLS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Half of a UTF-16 surrogate pair on its own. JSON can carry it (`"\ud800"`) but it is not
 * text, and the Messages API can reject a body holding one with a 400: left in, a user could
 * make their own call fail as `rejected` at will (see the breaker, src/coach/breaker.ts).
 */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Collapses whitespace (newlines included) and removes invisible or control characters and
 * lone surrogates.
 */
export function oneLine(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '').replace(CONTROLS_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * The user's text as prompt data: one line, and no angle brackets, so it can never close the
 * `<datos_usuario>` wrapper or open a tag of its own.
 */
export function promptSafe(text: string): string {
  return oneLine(text).replace(/</g, '‹').replace(/>/g, '›');
}

/** Wraps user-typed text as data inside the prompt. */
export function userData(fields: ReadonlyArray<readonly [tag: string, value: string]>): string {
  const inner = fields.map(([tag, value]) => `<${tag}>${promptSafe(value)}</${tag}>`).join('\n');
  return `<datos_usuario>\n${inner}\n</datos_usuario>`;
}

/** Shortens `text` to `max` characters at a word boundary when possible, with «…». */
export function clampText(text: string, max: number): string {
  const clean = oneLine(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space >= max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.-]+$/, '')}…`;
}

/** Negative numbers get the typographic minus sign «−» (house style). */
export function typographicMinus(text: string): string {
  return text.replace(/(^|[\s(«"'])-(?=\d)/g, '$1−');
}

/** Output text shown to the user: clean, clamped and in house style. Empty stays empty. */
export function outputText(text: string, max: number): string {
  return clampText(typographicMinus(text), max);
}
