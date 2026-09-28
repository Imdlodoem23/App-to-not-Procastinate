/**
 * Reward allowances («15 min de YouTube por 150 puntos»): the guardian drops the service's
 * hosts from `blockDomains` while the allowance lasts, and puts them back when it ends.
 */
import { addBlockAndWait, blockedUrl, expect, fakeTitle, test } from './support/extension';

test('an allowance lets YouTube through until it ends', async ({ extension, guardian }) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25 });
  const before = await extension.open('https://www.youtube.com/');
  await expect(before).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  await guardian.waitForAttempt();

  guardian.addAllowance('youtube', 0.25); // 15 s
  await guardian.waitForApplied();
  expect(guardian.rules().blockDomains).not.toContain('www.youtube.com');
  const page = await extension.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(page).toHaveTitle(fakeTitle('https://www.youtube.com/'));
  expect((await extension.state()).rules?.allowances.map((a) => a.serviceId)).toEqual(['youtube']);

  // When it ends the open tab goes back to blocked.html, which is not a new attempt.
  await expect(page).toHaveURL(
    blockedUrl({ cause: 'domain', serviceId: 'youtube', enforced: true }),
    {
      timeout: 30_000,
    },
  );
  expect(guardian.attempts()).toHaveLength(1);
});
