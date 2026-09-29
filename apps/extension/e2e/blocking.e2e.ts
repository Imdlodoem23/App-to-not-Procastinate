/**
 * Blocking a site: the declarativeNetRequest redirect to blocked.html, the attempt the
 * background reports on commit (docs/ARCHITECTURE.md §9.5) with its escalating penalty,
 * and tabs that were already open when the block started.
 */
import { addBlockAndWait, blockedUrl, expect, fakeTitle, test } from './support/extension';
import { expectBlockedPage } from './support/pages';

const REASON = 'Estudiar física para el lunes';

test('a blocked site lands on blocked.html with the reason, the time left and «−10 puntos»', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, {
    services: ['youtube', 'instagram'],
    minutes: 25,
    reason: REASON,
  });

  const page = await extension.open('https://www.youtube.com/');
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));

  // Only the hostname leaves the browser.
  const attempt = await guardian.waitForAttempt();
  expect(attempt.request).toEqual({
    layer: 'extension',
    target: { type: 'domain', value: 'www.youtube.com' },
    browser: 'chromium',
    incognito: false,
  });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  await expectBlockedPage(page, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: '−10 puntos',
  });
  await expect
    .poll(async () => (await extension.blockedTabs()).map((info) => info.status))
    .toEqual(['counted']);

  // Another attempt within 5 minutes costs double.
  const second = await extension.open('https://www.instagram.com/');
  await expect(second).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'instagram' }));
  const escalated = await guardian.waitForAttempt(
    (a) => a.request.target.value === 'www.instagram.com',
  );
  expect(escalated.response).toMatchObject({ counted: true, pointsDelta: -20, escalationIndex: 1 });
  await expectBlockedPage(second, {
    service: 'Instagram',
    reason: REASON,
    points: '−20 puntos',
  });
  expect(guardian.balance).toBe(-30);

  // Reloading the blocked page is not another attempt.
  await page.reload();
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  await expectBlockedPage(page, { reason: REASON, points: '−10 puntos' });
  expect(guardian.attempts()).toHaveLength(2);
});

test('a tab already on the site moves to blocked.html when a block starts, without points', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const tab = await extension.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(tab).toHaveTitle(fakeTitle('https://www.youtube.com/'));

  guardian.addBlock({ services: ['youtube'], minutes: 25, reason: REASON });
  await expect(tab).toHaveURL(
    blockedUrl({ cause: 'domain', serviceId: 'youtube', enforced: true }),
  );
  await expectBlockedPage(tab, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: null,
  });
  await expect
    .poll(async () => (await extension.blockedTabs()).map((info) => info.status))
    .toEqual(['enforced']);
  expect(guardian.attempts()).toHaveLength(0);

  // Sites outside the block keep working.
  const other = await extension.open('https://example.com/');
  await expect(other).toHaveTitle(fakeTitle('https://example.com/'));
});
