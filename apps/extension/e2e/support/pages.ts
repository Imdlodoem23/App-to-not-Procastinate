/**
 * What the suite expects to read on the extension pages. The copy follows PROMPT.md §10
 * («blocked.html y la ventana emergente de la extensión»): «YouTube: bloqueado» ·
 * «quedan 43 min», the user's reason, «−10 puntos» (typographic minus), and the single
 * tile «Volver a lo mío». Matching is by visible text and accessible names only, so the
 * pages are free to structure their markup.
 *
 * The pages speak the browser's UI language (src/pages/i18n): the Chromium suite launches
 * in Spanish by default (`uiLocale`), so the helpers default to `PAGES_ES`; pass the table
 * the browser uses otherwise (`PAGES_EN` in English).
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { PagesMessages } from '../../src/pages/i18n';
import { PAGES_ES } from '../../src/pages/i18n';

export interface BlockedPageExpectation {
  /** Catalog display name («YouTube»), shown as «YouTube: bloqueado». */
  service?: string;
  /** «Tu motivo». */
  reason: string;
  /** Minutes the page may show in «quedan N min» (rounding either way). */
  minutesLeft?: readonly number[];
  /** «−10 puntos»; `null`: the page must show no points lost (tab moved, not an attempt). */
  points?: string | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** «quedan 24 min» / «quedan 25 min» («24 min left» in English). */
export function minutesLeftText(
  minutes: readonly number[],
  copy: PagesMessages = PAGES_ES,
): RegExp {
  const words = minutes.map((n) =>
    escapeRegExp(copy.common.remaining.words(n, `${n} min`)).replace(/ /g, '\\s+'),
  );
  return new RegExp(`(?:${words.join('|')})`, 'i');
}

/** Any «−N puntos» (U+2212, never a hyphen). */
export const POINTS_LOST = /−\d+\s*puntos/;

/** Any points lost in `copy`'s language («−N puntos», «−N points»). */
export function pointsLost(copy: PagesMessages = PAGES_ES): RegExp {
  const unit = copy.common.points.long('', 10).trim();
  return new RegExp(`−\\d[\\d.,]*\\s*${escapeRegExp(unit)}`);
}

/** «−10 puntos», «−10 points». */
export function pointsText(delta: number, copy: PagesMessages = PAGES_ES): string {
  return copy.common.points.long(`${delta < 0 ? '−' : ''}${Math.abs(delta)}`, delta);
}

function visible(locator: Locator): Promise<void> {
  return expect(locator.first()).toBeVisible();
}

export async function expectBlockedPage(
  page: Page,
  expected: BlockedPageExpectation,
  copy: PagesMessages = PAGES_ES,
): Promise<void> {
  if (expected.service !== undefined) {
    await visible(page.getByText(copy.blocked.title(expected.service)));
  }
  await visible(page.getByText(expected.reason));
  if (expected.minutesLeft !== undefined) {
    await visible(page.getByText(minutesLeftText(expected.minutesLeft, copy)));
  }
  if (typeof expected.points === 'string') {
    await visible(page.getByText(expected.points));
  } else if (expected.points === null) {
    await expect(page.getByText(pointsLost(copy))).toHaveCount(0);
  }
  await visible(page.getByText(copy.blocked.back));
}
