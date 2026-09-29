/**
 * English: a browser whose UI language is English (`chrome.i18n.getUILanguage()`) gets the
 * English pages (src/pages/i18n/en.ts) and the English store texts (_locales/en); the rest
 * of the suite runs in Spanish.
 */
import { PAGES_EN } from '../src/pages/i18n';
import { addBlockAndWait, blockedUrl, expect, test } from './support/extension';
import { expectBlockedPage, pointsText } from './support/pages';

test.use({ uiLocale: 'en-US' });

const REASON = 'Study physics for Monday';

test('blocked.html, the popup and the guide speak English', async ({ extension, guardian }) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  const page = await extension.open('https://www.youtube.com/');
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  const attempt = await guardian.waitForAttempt();
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  await expectBlockedPage(
    page,
    {
      service: 'YouTube',
      reason: REASON,
      minutesLeft: [24, 25],
      points: pointsText(-10, PAGES_EN),
    },
    PAGES_EN,
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('YouTube: blocked · Céntrate');
  await expect(page.getByText(PAGES_EN.blocked.reasonLabel)).toBeVisible();
  await expect(page.getByRole('button', { name: PAGES_EN.blocked.back })).toHaveAttribute(
    'aria-keyshortcuts',
    'Alt+B',
  );

  const popup = await extension.openPopup();
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await expect(popup.getByText('Block: YouTube · Strict')).toBeVisible();
  // «until tomorrow 12:20 AM» when the run is 25 min before midnight (CI runs in Europe/Madrid).
  await expect(popup.getByText(/^until (tomorrow )?\d{1,2}:\d{2}\s[AP]M$/)).toBeVisible();
  await expect(popup.getByText(PAGES_EN.status.connected)).toBeVisible();
  await expect(popup.getByRole('button', { name: PAGES_EN.common.guide })).toBeVisible();

  const guide = await extension.openGuide('pairing');
  await expect(guide).toHaveTitle(PAGES_EN.guide.documentTitle);
  await expect(guide.getByRole('heading', { name: PAGES_EN.guide.title })).toBeVisible();
  await expect(guide.getByRole('heading', { name: PAGES_EN.guide.pairing.done })).toBeVisible();

  // The manifest's name and description come from _locales/en.
  const manifest = await popup.evaluate(() => {
    const { name, description } = chrome.runtime.getManifest();
    return { name, description };
  });
  expect(manifest.name).toBe('Céntrate');
  expect(manifest.description).toMatch(/^Block your distractions with Céntrate/);
});
