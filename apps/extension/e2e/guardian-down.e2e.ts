/**
 * Without the guardian the extension keeps the last verified rules until each block's own
 * `endsAt`: stopping the guardian never unblocks early, and the popup says what is going on
 * (docs/ARCHITECTURE.md §8.8).
 */
import { MESSAGE_TYPES } from '../src/background/state';
import { addBlockAndWait, blockedUrl, expect, fakeTitle, test } from './support/extension';
import { expectBlockedPage } from './support/pages';

const REASON = 'Terminar el TFG';

test('the guardian stops: the cached block stays in force and the popup says so', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  await guardian.stop();
  await expect.poll(async () => (await extension.state()).link).toBe('unreachable');
  const state = await extension.state();
  expect(state.protection).toBe('cached');
  expect(state.problems).toContain('guardian_unreachable');
  expect(state.rules?.blocks.map((b) => b.reason)).toEqual([REASON]);

  const page = await extension.open('https://www.youtube.com/');
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  await expect
    .poll(async () => (await extension.blockedTabs()).map((info) => info.status))
    .toEqual(['unreported']);
  expect(guardian.attempts()).toHaveLength(0);
  // Nobody could charge it: the page must not claim points were lost.
  await expectBlockedPage(page, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: null,
  });

  const popup = await extension.openPopup();
  await expect(popup.getByText(/guardián no responde/i).first()).toBeVisible();
  await expect(popup.getByText(/YouTube/).first()).toBeVisible();

  // Back online: the extension reconnects and the block is still there.
  await guardian.start();
  await extension.send({ type: MESSAGE_TYPES.refresh });
  await expect.poll(async () => (await extension.state()).link).toBe('connected');
  expect((await extension.state()).protection).toBe('active');
  const again = await extension.open('https://www.youtube.com/');
  await expect(again).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
});

test('a cached block ends at its own endsAt while the guardian is down, not before', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const endsAt = Date.now() + 15_000;
  await addBlockAndWait(guardian, { services: ['youtube'], endsAt, reason: REASON });

  await guardian.stop();
  await expect.poll(async () => (await extension.state()).link).toBe('unreachable');
  const page = await extension.open('https://www.youtube.com/');
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  expect(Date.now()).toBeLessThan(endsAt);

  await expect
    .poll(async () => (await extension.state()).rules?.blocks.length ?? 0, { timeout: 25_000 })
    .toBe(0);
  expect(Date.now()).toBeGreaterThanOrEqual(endsAt);
  const after = await extension.open('about:blank');
  await expect
    .poll(
      async () => {
        await after.goto('https://www.youtube.com/');
        return after.url();
      },
      { timeout: 10_000 },
    )
    .toBe('https://www.youtube.com/');
  await expect(after).toHaveTitle(fakeTitle('https://www.youtube.com/'));
});
