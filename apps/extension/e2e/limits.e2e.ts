/**
 * Daily limits (docs/ARCHITECTURE.md §5.10, §10.13): the extension counts the time the
 * focused tab spends on a limited site, reports only its hostname with `POST /v1/usage`, and
 * once the guardian says the allowance is used up (a block with `limitId`, served as
 * `manual`) the site is blocked like any other and blocked.html says why.
 */
import type { Page } from '@playwright/test';
import { PAGES_ES } from '../src/pages/i18n';
import { blockedUrl, expect, fakeTitle, test } from './support/extension';
import type { ExtensionHarness } from './support/extension';

/** The toolbar badge text of the tab showing `url` (the page's tab). */
async function badgeText(extension: ExtensionHarness, url: string): Promise<string> {
  return extension.worker.evaluate(async (wanted) => {
    const [tab] = await chrome.tabs.query({ url: wanted });
    if (tab?.id === undefined) return '(no tab)';
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, url);
}

/**
 * Pins what the browser reports about the user to «this window has the focus, the user is
 * active». Under xvfb every parallel browser shares one X focus and nobody touches the
 * keyboard, so after a minute `chrome.idle` says `idle` and another spec's window may hold
 * the focus. The rules for focus, idle and sound are unit-tested (test/background/usage.test.ts);
 * this suite checks everything around them in a real browser.
 */
async function pinActiveUser(extension: ExtensionHarness): Promise<void> {
  await extension.worker.evaluate(() => {
    const windows = chrome.windows as { getLastFocused: typeof chrome.windows.getLastFocused };
    const original = windows.getLastFocused.bind(chrome.windows);
    windows.getLastFocused = (async (options: chrome.windows.QueryOptions) => ({
      ...(await original(options)),
      focused: true,
    })) as typeof chrome.windows.getLastFocused;
    const idle = chrome.idle as { queryState: typeof chrome.idle.queryState };
    idle.queryState = (async () => 'active') as typeof chrome.idle.queryState;
  });
}

async function openFocused(extension: ExtensionHarness, url: string): Promise<Page> {
  await pinActiveUser(extension);
  const page = await extension.open(url);
  await page.bringToFront();
  return page;
}

test('the time on a limited site is reported by hostname and shown on the badge', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const limit = guardian.addLimit({ services: ['youtube'], dailyMinutes: 30 });
  await guardian.waitForApplied();
  guardian.setLimitUsage(limit.id, 18 * 60);

  const page = await openFocused(extension, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(page).toHaveTitle(fakeTitle('https://www.youtube.com/'));

  // The first report goes out within seconds (no answer yet), hostname only.
  const report = await guardian.waitForUsage((r) => r.request.items.length > 0, 20_000);
  expect(report.request.items).toEqual([
    { type: 'domain', value: 'www.youtube.com', seconds: expect.any(Number) },
  ]);
  expect(report.request.intervalMs).toBeGreaterThanOrEqual(1_000);
  expect(report.response.limits[0]).toMatchObject({ limitId: limit.id, appliesToday: true });
  expect(guardian.limits()[0]?.usedMs).toBeGreaterThan(18 * 60_000);

  // 12 minutes left minus the seconds counted since: «12m» on this tab.
  await expect.poll(() => badgeText(extension, 'https://www.youtube.com/*')).toMatch(/^1[12]m$/);

  // Another site counts nothing and shows no badge.
  const other = await openFocused(extension, 'https://example.com/');
  await expect(other).toHaveTitle(fakeTitle('https://example.com/'));
  await expect.poll(() => badgeText(extension, 'https://example.com/*')).toBe('');
  const reports = guardian.usageReports().length;
  await other.waitForTimeout(6_000);
  for (const r of guardian.usageReports().slice(reports)) {
    expect(r.request.items.map((i) => i.value)).not.toContain('example.com');
  }
});

test('a used-up allowance blocks the open tab and blocked.html says so', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const limit = guardian.addLimit({ services: ['youtube'], dailyMinutes: 5 });
  await guardian.waitForApplied();
  // Three seconds left: the next reports use them up.
  guardian.setLimitUsage(limit.id, 5 * 60 - 3);

  const tab = await openFocused(extension, 'https://www.youtube.com/');
  await expect(tab).toHaveTitle(fakeTitle('https://www.youtube.com/'));
  await expect(tab).toHaveURL(
    blockedUrl({ cause: 'domain', serviceId: 'youtube', enforced: true }),
    { timeout: 30_000 },
  );
  expect(guardian.blocks().find((b) => b.limitId === limit.id)).toBeDefined();
  await expect(tab.getByText(PAGES_ES.blocked.title('YouTube'))).toBeVisible();
  await expect(tab.getByText(PAGES_ES.blocked.limitLine(5, 'YouTube'))).toBeVisible();
  // Moved, not an attempt: nothing charged.
  expect(guardian.attempts()).toHaveLength(0);

  // Going back to the site is an attempt like any other, with the same line.
  const again = await extension.open('https://www.youtube.com/');
  await expect(again).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  const attempt = await guardian.waitForAttempt();
  expect(attempt.response.block).toMatchObject({ kind: 'manual', limitId: limit.id });
  await expect(again.getByText(PAGES_ES.blocked.limitLine(5, 'YouTube'))).toBeVisible();
});

test('without limits in the rules nothing is counted or reported', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const page = await openFocused(extension, 'https://www.youtube.com/');
  await expect(page).toHaveTitle(fakeTitle('https://www.youtube.com/'));
  await page.waitForTimeout(7_000);
  expect(guardian.requests().filter((r) => r.path === '/v1/usage')).toEqual([]);
});
