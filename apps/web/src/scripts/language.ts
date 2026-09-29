/**
 * Language choice in the browser (Base.astro):
 * - Every language switch ([data-lang-switch], in the bar, the footer and the hint) remembers
 *   the language it opens, so the hint does not come back.
 * - The hint ([data-lang-hint="en"] on a Spanish page, "es" on an English one) shows when the
 *   browser's language is the hint's and the visitor has not chosen a language yet. Dismissing
 *   it remembers the page's language. It never redirects.
 *
 * Storage can be blocked (private modes, site data off): then the hint simply shows again on
 * the next page, and nothing breaks.
 */
import { LANG_CHOICE_KEY } from '../lib/i18n';

function readChoice(): string | null {
  try {
    return window.localStorage.getItem(LANG_CHOICE_KEY);
  } catch {
    return null;
  }
}

function saveChoice(lang: string): void {
  try {
    window.localStorage.setItem(LANG_CHOICE_KEY, lang);
  } catch {
    // Not stored: the hint may show again, which is harmless.
  }
}

export function initLanguage(): void {
  for (const link of document.querySelectorAll<HTMLElement>('[data-lang-switch]')) {
    link.addEventListener('click', () => saveChoice(link.dataset.langSwitch ?? ''));
  }

  const hint = document.querySelector<HTMLElement>('[data-lang-hint]');
  const target = hint?.dataset.langHint;
  // Never offer the language the page is already in (the 404 may have swapped in its English
  // shell, hint included, before this runs: Base.astro).
  if (!hint || !target || document.documentElement.lang === target) return;

  const preferred = (navigator.language || '').toLowerCase();
  if (readChoice() !== null || !preferred.startsWith(target)) return;

  hint.hidden = false;
  const dismiss = hint.querySelector<HTMLButtonElement>('[data-lang-hint-dismiss]');
  dismiss?.addEventListener('click', () => {
    saveChoice(dismiss.dataset.langHintDismiss ?? '');
    hint.hidden = true;
    // Keep the focus on the page, not on a removed control.
    document.getElementById('contenido')?.focus({ preventScroll: true });
  });
}
