/**
 * The pairing form of the popup and the guide (docs/ARCHITECTURE.md §9.3): the 6-digit code
 * the app shows (and the port, only when the app shows «Puerto: N»). The background claims
 * the token; this form only collects the code and explains errors in the pages' language,
 * each with what to do. Success is the page's to say: it hides the form, so it confirms in a
 * live region of its own and moves the focus (a live region inside the hidden form is never
 * read).
 */
import type { ExtensionStateSnapshot } from '../../background/state';
import { PAGES } from '../i18n';
import { el, nextId, setText, show } from './dom';
import type { PairAnswer } from './runtime';
import { pair as pairWithBackground } from './runtime';

/** The error line for a failed claim (`null` answer: the background did not reply). */
export function pairErrorText(answer: Exclude<PairAnswer, { ok: true }>): string {
  const p = PAGES.pairing;
  if (answer === null) return p.extensionUnavailable;
  if (!('retryAfterSeconds' in answer)) return p.errors.unexpected;
  const wait = answer.retryAfterSeconds;
  if (answer.error === 'rate_limited' && wait !== null && wait > 0) {
    return p.rateLimitedFor(Math.ceil(wait));
  }
  return p.errors[answer.error];
}

/**
 * The port field: `undefined` when empty (the default port), the number when valid, `null`
 * when it is not a port.
 */
export function parsePortInput(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}

export interface PairingFormOptions {
  /**
   * Called with the new snapshot after a successful claim, with the form already reset. The
   * page confirms it (a `role="status"` line) and moves the focus off the form it hides.
   */
  onPaired(state: ExtensionStateSnapshot): void;
  /** Injectable for tests and previews. */
  pair?: (code: string, port?: number) => Promise<PairAnswer>;
}

export interface PairingForm {
  readonly element: HTMLFormElement;
  readonly input: HTMLInputElement;
  focus(): void;
  /** Empties the code and clears the help line, its tone and `aria-invalid` (a fresh form). */
  reset(): void;
}

export function createPairingForm(options: PairingFormOptions): PairingForm {
  const p = PAGES.pairing;
  const pair = options.pair ?? pairWithBackground;
  const codeId = nextId('pair-code');
  const portId = nextId('pair-port');
  const helpId = nextId('pair-help');

  const input = el('input', {
    id: codeId,
    className: 'field field--code',
    attrs: {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      spellcheck: 'false',
      maxlength: 16,
      placeholder: p.codePlaceholder,
      'aria-describedby': helpId,
      required: true,
    },
  });
  const submit = el('button', {
    className: 'button-confirm',
    text: p.submit,
    attrs: { type: 'submit' },
  });
  const help = el('p', {
    id: helpId,
    className: 'help',
    attrs: { 'aria-live': 'polite' },
  });
  const portInput = el('input', {
    id: portId,
    className: 'field field--port',
    attrs: {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 5,
      placeholder: '47600',
      'aria-describedby': helpId,
    },
  });
  const portRow = el('div', { className: 'pairing-port' }, [
    el('label', { className: 'label', text: p.portLabel, attrs: { for: portId } }),
    portInput,
  ]);
  portRow.hidden = true;
  const portToggle = el('button', {
    className: 'link-button',
    text: p.portToggle,
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': portId },
  });
  const portHelp = el('span', {
    className: 'visually-hidden',
    text: p.portToggleHelp,
    id: nextId('port-help'),
  });
  portToggle.setAttribute('aria-describedby', portHelp.id);

  const form = el('form', { className: 'pairing-form', attrs: { novalidate: true } }, [
    el('label', { className: 'label', text: p.codeLabel, attrs: { for: codeId } }),
    el('div', { className: 'pairing-row' }, [input, submit]),
    portRow,
    help,
    el('div', { className: 'pairing-more' }, [portToggle, portHelp]),
  ]);

  let busy = false;
  const setError = (text: string | null): void => {
    help.dataset['tone'] = text === null ? '' : 'red';
    setText(help, text ?? '');
    input.setAttribute('aria-invalid', text === null ? 'false' : 'true');
  };
  const reset = (): void => {
    input.value = '';
    setError(null);
  };

  portToggle.addEventListener('click', () => {
    const open = portRow.hidden !== false;
    show(portRow, open);
    portToggle.setAttribute('aria-expanded', String(open));
    if (open) portInput.focus();
  });

  input.addEventListener('input', () => {
    if (help.dataset['tone'] === 'red') setError(null);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const port = parsePortInput(portInput.value);
    if (port === null) {
      setError(p.badPort);
      portInput.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    setText(submit, p.submitting);
    setError(null);
    void pair(input.value, port)
      .then((answer) => {
        if (answer !== null && answer.ok) {
          // No success text here: the page hides the form and says it (onPaired).
          reset();
          options.onPaired(answer.state);
          return;
        }
        setError(pairErrorText(answer));
        input.focus();
        input.select();
      })
      .finally(() => {
        busy = false;
        submit.disabled = false;
        setText(submit, p.submit);
      });
  });

  return { element: form, input, focus: () => input.focus(), reset };
}
