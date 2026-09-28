/**
 * Tiny DOM helpers for the extension pages (no framework). Text always goes through
 * `textContent`, never `innerHTML`: blocked.html is web-accessible and shows values that come
 * from its query string and from the guardian.
 */
import type { IconName } from './icons';
import { createIcon } from './icons';

type Child = Node | string | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;

export interface ElProps {
  className?: string;
  id?: string;
  text?: string;
  attrs?: Record<string, AttrValue>;
}

/** `document.createElement` with a class, an id, text, attributes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className !== undefined) node.className = props.className;
  if (props.id !== undefined) node.id = props.id;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

/** A decorative lucide-shaped icon (16 px in headers and the footer, 20 px in tiles). */
export function icon(name: IconName, size: 16 | 20 | 24 = 16): SVGSVGElement {
  return createIcon(document, name, size);
}

/** The element with `id` (the page's static skeleton); throws if the HTML lacks it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Céntrate: #${id} is missing from the page`);
  return node as T;
}

/** Sets text only when it changed (no needless layout or screen reader churn). */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Sets or removes an attribute only when it changed. */
export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

/** Shows or hides with the `hidden` attribute (PROMPT §10: hide what does not apply). */
export function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible;
}

let uid = 0;
/** A page-unique id for `aria-*` references. */
export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * G-Helper help line: `help` shows the help of the control under the mouse or with the focus,
 * else `fallback`. Each control is described by it (`aria-describedby`); its height is
 * reserved in CSS so nothing jumps.
 */
export function bindHelp(
  help: HTMLElement,
  controls: ReadonlyArray<readonly [HTMLElement, string]>,
  fallback = '',
): { setFallback(text: string): void } {
  if (help.id === '') help.id = nextId('help');
  let current = fallback;
  let hovered: string | null = null;
  let focused: string | null = null;
  const render = (): void => setText(help, hovered ?? focused ?? current);
  for (const [control, text] of controls) {
    const described = control.getAttribute('aria-describedby');
    const ids = new Set((described ?? '').split(/\s+/).filter(Boolean));
    ids.add(help.id);
    control.setAttribute('aria-describedby', [...ids].join(' '));
    control.addEventListener('pointerenter', () => {
      hovered = text;
      render();
    });
    control.addEventListener('pointerleave', () => {
      hovered = null;
      render();
    });
    control.addEventListener('focus', () => {
      focused = text;
      render();
    });
    control.addEventListener('blur', () => {
      focused = null;
      render();
    });
  }
  render();
  return {
    setFallback(text) {
      current = text;
      render();
    },
  };
}
