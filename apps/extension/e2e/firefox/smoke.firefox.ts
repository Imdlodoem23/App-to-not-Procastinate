/**
 * Firefox smoke: the same build in a real Firefox (≥ 128), where the extension runs as an
 * ES-module event page and several paths differ from Chromium (harness.ts):
 *
 * - pairing binds the token to the `moz-extension://` origin and the `firefox` family;
 * - DNR's redirect to blocked.html is a separate load with its own `onBeforeNavigate`,
 *   and the attempt must still be counted once (background/attempts.ts);
 * - «reopen closed tab» commits the restored URL before loading it as a history load: it
 *   must cost nothing, like a tab that was open when the block started;
 * - the event page is suspended when idle and its persistent listeners wake it up;
 * - whitelist host patterns go through DNR `regexFilter` (`isRegexSupported`).
 */
import { MESSAGE_TYPES } from '../../src/background/state';
import { addBlockAndWait, fakeTitle } from '../support/extension';
import type { BlockedPageExpectation } from '../support/pages';
import { POINTS_LOST, minutesLeftText } from '../support/pages';
import { REDIRECT_PARAM } from './fake-web';
import type { FirefoxTab } from './harness';
import { FIREFOX_ORIGIN, expect, firefoxBlockedUrl, firefoxExtensionUrl, test } from './harness';

const REASON = 'Estudiar física para el lunes';

/** An `<input>` by the text of its `<label for>`. */
const inputLabelled = (label: string): string =>
  `//input[@id=(//label[normalize-space(.)='${label}']/@for)]`;
const button = (text: string): string => `//button[normalize-space(.)='${text}']`;

/**
 * Time for a late event (a second report, a webRequest redirect after the commit) to show
 * up before asserting that nothing more happened.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1_500));

/** support/pages.ts `expectBlockedPage`, on the page's text. */
async function expectBlockedPage(tab: FirefoxTab, expected: BlockedPageExpectation) {
  const wanted: Array<string | RegExp> = [expected.reason, 'Volver a lo mío'];
  if (expected.service !== undefined) {
    wanted.push(new RegExp(`${expected.service}:\\s*bloquead`, 'i'));
  }
  if (expected.minutesLeft !== undefined) wanted.push(minutesLeftText(expected.minutesLeft));
  if (typeof expected.points === 'string') wanted.push(expected.points);
  await expect
    .poll(async () => {
      const text = await tab.text();
      return wanted
        .filter((w) => (typeof w === 'string' ? !text.includes(w) : !w.test(text)))
        .map(String);
    })
    .toEqual([]);
  if (expected.points === null) expect(await tab.text()).not.toMatch(POINTS_LOST);
}

test('pairs from the popup with the code and the port the app shows', async ({
  firefox,
  guardian,
}) => {
  const code = guardian.newPairingCode();
  const popup = await firefox.openPopup();
  await popup.type(
    inputLabelled('Código de emparejamiento'),
    `${code.slice(0, 3)} ${code.slice(3)}`,
  );
  await popup.click(button('Otro puerto…'));
  await popup.type(inputLabelled('Puerto'), String(guardian.port));
  await popup.click(button('Emparejar'));

  await expect.poll(async () => (await firefox.state()).paired).toBe(true);
  const [paired] = guardian.extensions();
  expect(paired?.boundOrigin).toBe(FIREFOX_ORIGIN);
  expect(paired?.browser).toBe('firefox');
  expect(guardian.pairingCode).toBeNull();

  await guardian.waitForApplied();
  const beat = await guardian.waitForHeartbeat();
  expect(beat.body).toMatchObject({ browser: 'firefox', hostPermission: true });
  await expect.poll(async () => (await firefox.state()).link).toBe('connected');
  const state = await firefox.state();
  expect(state.browser).toMatchObject({ family: 'firefox', engine: 'firefox' });
  expect(state.needsHostPermission).toBe(false);
});

test('a blocked site lands on blocked.html and counts one attempt, also through a redirector', async ({
  firefox,
  guardian,
}) => {
  await firefox.pair(guardian);
  await addBlockAndWait(guardian, {
    services: ['youtube', 'instagram'],
    minutes: 25,
    reason: REASON,
  });

  const tab = await firefox.open('https://www.youtube.com/');
  expect(await tab.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  const attempt = await guardian.waitForAttempt();
  expect(attempt.request).toEqual({
    layer: 'extension',
    target: { type: 'domain', value: 'www.youtube.com' },
    browser: 'firefox',
    incognito: false,
  });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  await expectBlockedPage(tab, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: '−10 puntos',
  });
  await expect
    .poll(async () => (await firefox.blockedTabs()).map((info) => info.status))
    .toEqual(['counted']);

  // Reloading the blocked page is not another attempt.
  await tab.reload();
  await expectBlockedPage(tab, { reason: REASON, points: '−10 puntos' });

  // A link through a redirector counts the site it led to (−20: within 5 min).
  const target = encodeURIComponent('https://www.instagram.com/');
  const via = await firefox.open(`http://t.co/abc?${REDIRECT_PARAM}=${target}`);
  expect(await via.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'instagram' }));
  const second = await guardian.waitForAttempt((a) => a.request.target.value !== 'www.youtube.com');
  expect(second.request.target).toEqual({ type: 'domain', value: 'www.instagram.com' });
  expect(second.response).toMatchObject({ counted: true, pointsDelta: -20 });
  await expectBlockedPage(via, { service: 'Instagram', reason: REASON, points: '−20 puntos' });

  await settle();
  expect(guardian.attempts()).toHaveLength(2);
  expect(guardian.balance).toBe(-30);
});

test('a tab already on the site moves to blocked.html when a block starts, without points', async ({
  firefox,
  guardian,
}) => {
  await firefox.pair(guardian);
  const tab = await firefox.open('http://www.youtube.com/watch?v=dQw4w9WgXcQ');
  expect(await tab.title()).toBe(fakeTitle('http://www.youtube.com/'));

  guardian.addBlock({ services: ['youtube'], minutes: 25, reason: REASON });
  await expect
    .poll(() => tab.url())
    .toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube', enforced: true }));
  await expectBlockedPage(tab, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: null,
  });
  await expect
    .poll(async () => (await firefox.blockedTabs()).map((info) => info.status))
    .toEqual(['enforced']);

  // Sites outside the block keep working.
  const other = await firefox.open('http://example.com/');
  expect(await other.title()).toBe(fakeTitle('http://example.com/'));
  await settle();
  expect(guardian.attempts()).toHaveLength(0);
});

test('a reopened tab of a site blocked meanwhile costs nothing', async ({ firefox, guardian }) => {
  await firefox.pair(guardian);
  const tab = await firefox.open('http://www.youtube.com/watch?v=abc');
  expect(await tab.title()).toBe(fakeTitle('http://www.youtube.com/'));
  await tab.close();
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  // Firefox commits the restored URL first, then loads it as a history navigation (which
  // DNR redirects): neither is an attempt.
  const restored = await firefox.reopenClosedTab();
  await expect
    .poll(() => restored.url())
    .toMatch(/^moz-extension:\/\/[^/]+\/blocked\.html\?cause=domain&service=youtube/);
  await expectBlockedPage(restored, { service: 'YouTube', reason: REASON, points: null });
  await settle();
  expect(guardian.attempts()).toHaveLength(0);
  const statuses = (await firefox.blockedTabs()).map((info) => info.status);
  expect(statuses).toHaveLength(1);
  expect(['enforced', 'ignored']).toContain(statuses[0]);
});

test('the guardian stops: the cached block stays in force and the popup says so', async ({
  firefox,
  guardian,
}) => {
  await firefox.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  await guardian.stop();
  await expect.poll(async () => (await firefox.state()).link).toBe('unreachable');
  const state = await firefox.state();
  expect(state.protection).toBe('cached');
  expect(state.problems).toContain('guardian_unreachable');
  expect(state.rules?.blocks.map((b) => b.reason)).toEqual([REASON]);

  const tab = await firefox.open('https://www.youtube.com/');
  expect(await tab.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  await expect
    .poll(async () => (await firefox.blockedTabs()).map((info) => info.status))
    .toEqual(['unreported']);
  await expectBlockedPage(tab, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: null,
  });
  expect(guardian.attempts()).toHaveLength(0);

  const popup = await firefox.openPopup();
  await expect.poll(() => popup.text()).toMatch(/guardián no responde/i);
  expect(await popup.text()).toMatch(/YouTube/);

  // Back online: the extension reconnects and the block is still there.
  await guardian.start();
  await firefox.send({ type: MESSAGE_TYPES.refresh });
  await expect.poll(async () => (await firefox.state()).link).toBe('connected');
  expect((await firefox.state()).protection).toBe('active');
  const again = await firefox.open('https://www.youtube.com/');
  expect(await again.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube' }));
});

test('whitelist mode: host patterns (regexFilter) let lh3.googleusercontent.com through', async ({
  firefox,
  guardian,
}) => {
  await firefox.pair(guardian);
  const block = await addBlockAndWait(guardian, {
    whitelistOnly: true,
    minutes: 60,
    reason: 'Examen de historia',
  });

  // ^lh[3-7](?:-[a-z]+)?\.googleusercontent\.com$ allows lh3, not lh9.
  const pattern = await firefox.open('http://lh3.googleusercontent.com/a/photo');
  expect(await pattern.title()).toBe(fakeTitle('http://lh3.googleusercontent.com/'));
  const wikipedia = await firefox.open('http://es.wikipedia.org/wiki/Revoluci%C3%B3n_francesa');
  expect(await wikipedia.title()).toBe(fakeTitle('http://es.wikipedia.org/'));
  const other = await firefox.open('http://lh9.googleusercontent.com/a/photo');
  expect(await other.url()).toBe(firefoxBlockedUrl({ cause: 'whitelist' }));

  const attempt = await guardian.waitForAttempt();
  expect(attempt.request.target).toEqual({ type: 'domain', value: 'lh9.googleusercontent.com' });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  expect(attempt.response.block?.id).toBe(block.id);
  await expectBlockedPage(other, { reason: 'Examen de historia', points: '−10 puntos' });
});

test('site access withdrawn: the guide asks for it again and the extension recovers', async ({
  firefox,
  guardian,
}) => {
  await firefox.pair(guardian);
  expect((await firefox.state()).needsHostPermission).toBe(false);

  // Firefox lets the user withdraw MV3 host permissions (about:addons › Permisos).
  expect(
    await firefox.inExtensionPage<boolean>(
      'return browser.permissions.remove({ origins: ["<all_urls>"] });',
    ),
  ).toBe(true);
  await expect.poll(async () => (await firefox.state()).protection).toBe('limited');
  expect((await firefox.state()).problems).toContain('host_permission_missing');
  await guardian.waitForHeartbeat((beat) => beat.body.hostPermission === false);
  const popup = await firefox.openPopup();
  await expect.poll(() => popup.text()).toContain('Dar permiso');

  // permissions.request from a click in the guide shows Firefox's prompt; the background
  // hears permissions.onAdded by itself (the popup, which that prompt closes, is not needed).
  const guide = await firefox.open(firefoxExtensionUrl('options.html#host-permission'));
  const since = Date.now();
  await guide.click(button('Dar permiso'));
  await firefox.acceptPermissionPrompt();
  await expect.poll(async () => (await firefox.state()).protection).toBe('active');
  expect((await firefox.state()).needsHostPermission).toBe(false);
  await guardian.waitForHeartbeat((beat) => beat.at >= since && beat.body.hostPermission);

  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });
  const tab = await firefox.open('https://www.youtube.com/');
  expect(await tab.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube' }));
});

test.describe('with a short idle timeout', () => {
  test.use({ idleTimeoutMs: 2_000 });

  test('a blocked navigation wakes the suspended event page and counts', async ({
    firefox,
    guardian,
  }) => {
    guardian.addBlock({ services: ['youtube'], minutes: 25, reason: REASON });
    await firefox.pair(guardian);
    await expect.poll(() => firefox.backgroundState(), { timeout: 20_000 }).toBe('stopped');

    const tab = await firefox.open('https://www.youtube.com/');
    expect(await tab.url()).toBe(firefoxBlockedUrl({ cause: 'domain', serviceId: 'youtube' }));
    const attempt = await guardian.waitForAttempt();
    expect(attempt.request.target).toEqual({ type: 'domain', value: 'www.youtube.com' });
    expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
    await expectBlockedPage(tab, { service: 'YouTube', reason: REASON, points: '−10 puntos' });
  });
});
