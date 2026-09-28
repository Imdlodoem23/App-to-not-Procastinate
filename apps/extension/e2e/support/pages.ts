/**
 * What the suite expects to read on the extension pages. The copy follows PROMPT.md §10
 * («blocked.html y la ventana emergente de la extensión»): «YouTube: bloqueado» ·
 * «quedan 43 min», the user's reason, «−10 puntos» (typographic minus), and the single
 * tile «Volver a lo mío». Matching is by visible text and accessible names only, so the
 * pages are free to structure their markup.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

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

/** «quedan 24 min» / «quedan 25 min». */
export function minutesLeftText(minutes: readonly number[]): RegExp {
  return new RegExp(`quedan\\s+(?:${minutes.join('|')})\\s*min`, 'i');
}

/** Any «−N puntos» (U+2212, never a hyphen). */
export const POINTS_LOST = /−\d+\s*puntos/;

function visible(locator: Locator): Promise<void> {
  return expect(locator.first()).toBeVisible();
}

export async function expectBlockedPage(
  page: Page,
  expected: BlockedPageExpectation,
): Promise<void> {
  if (expected.service !== undefined) {
    await visible(page.getByText(new RegExp(`${expected.service}:\\s*bloquead`, 'i')));
  }
  await visible(page.getByText(expected.reason));
  if (expected.minutesLeft !== undefined) {
    await visible(page.getByText(minutesLeftText(expected.minutesLeft)));
  }
  if (typeof expected.points === 'string') {
    await visible(page.getByText(expected.points));
  } else if (expected.points === null) {
    await expect(page.getByText(POINTS_LOST)).toHaveCount(0);
  }
  await visible(page.getByText('Volver a lo mío'));
}
