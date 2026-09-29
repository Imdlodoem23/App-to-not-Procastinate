/**
 * Whitelist mode (exam, level-2 punishment): every site is blocked except the allowed ones
 * (the catalog study whitelist, which includes Wikipedia). Loopback stays reachable, so the
 * guardian keeps answering.
 */
import { addBlockAndWait, blockedUrl, expect, fakeTitle, test } from './support/extension';
import { expectBlockedPage } from './support/pages';

const REASON = 'Examen de historia';

test('whitelist mode blocks example.org and lets es.wikipedia.org through', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  const block = await addBlockAndWait(guardian, {
    whitelistOnly: true,
    minutes: 60,
    reason: REASON,
  });
  expect(block.mode).toBe('exam');

  const blocked = await extension.open('https://example.org/');
  await expect(blocked).toHaveURL(blockedUrl({ cause: 'whitelist' }));
  const attempt = await guardian.waitForAttempt();
  expect(attempt.request.target).toEqual({ type: 'domain', value: 'example.org' });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  expect(attempt.response.block?.id).toBe(block.id);
  await expectBlockedPage(blocked, {
    service: 'example.org',
    reason: REASON,
    points: '−10 puntos',
  });

  const wikipedia = await extension.open('https://es.wikipedia.org/wiki/Revoluci%C3%B3n_francesa');
  await expect(wikipedia).toHaveTitle(fakeTitle('https://es.wikipedia.org/'));
  expect(guardian.attempts()).toHaveLength(1);

  // The guardian (loopback) is still reachable under the whitelist.
  const since = Date.now();
  await extension.send({ type: 'centrate/refresh' });
  await guardian.waitForHeartbeat((beat) => beat.at >= since);
  expect((await extension.state()).link).toBe('connected');
});
