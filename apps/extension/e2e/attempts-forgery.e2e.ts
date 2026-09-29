/**
 * Attempts a web page starts are blocked but never cost points (background/attempts.ts,
 * docs/ARCHITECTURE.md §9.5 and cheat matrix #28), the whitelist is not escaped through a
 * `data:` document, and a move of an open tab that the user cancels is retried.
 *
 * Chromium facts these tests pin (checked on Chromium 141): a meta refresh commits with
 * the `client_redirect` qualifier; an opener navigating its popup commits as a plain
 * `link`, but `webRequest.onBeforeRequest` reports the opener as `initiator`, also for the
 * request DNR redirects; a page's own `location = …` after load looks like a click (no
 * qualifier, its own origin as initiator), so it still counts (DECISIONS.md).
 */
import type { Page } from '@playwright/test';
import { addBlockAndWait, blockedUrl, expect, test } from './support/extension';

const REASON = 'Terminar el trabajo de historia';

async function statusOf(
  extension: { blockedTabs(): Promise<Array<{ host: string | null; status: string }>> },
  host: string,
): Promise<string | undefined> {
  return (await extension.blockedTabs()).find((info) => info.host === host)?.status;
}

test('a meta refresh to YouTube is blocked but costs nothing', async ({ extension, guardian }) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  const page = await extension.open('https://example.net/articulo');
  await page.setContent(
    '<meta http-equiv="refresh" content="0;url=https://www.youtube.com/watch?v=1"><p>Espera</p>',
  );
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  await expect.poll(() => statusOf(extension, 'www.youtube.com')).toBe('not_counted');
  expect(guardian.attempts()).toEqual([]);
});

test('an opener driving its popup to blocked sites costs nothing; typing there does', async ({
  extension,
  guardian,
}) => {
  test.setTimeout(90_000);
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  const opener = await extension.open('https://ads.example.net/');
  // The popup opens on a click; the opener navigates it once the click's activation expired.
  await opener.setContent(
    `<button onclick="const w = window.open('https://pop.example.com/');
       setTimeout(() => { w.location.href = 'https://www.youtube.com/watch?v=2'; }, 6500)">
       Abrir</button>`,
  );
  const [popup] = await Promise.all([
    extension.context.waitForEvent('page'),
    opener.getByRole('button').click(),
  ]);
  await expect(popup).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }), {
    timeout: 15_000,
  });
  await expect.poll(() => statusOf(extension, 'www.youtube.com')).toBe('not_counted');
  expect(guardian.attempts()).toEqual([]);

  // The user typing the blocked site in that same tab is an attempt.
  await popup.goto('https://www.youtube.com/');
  const attempt = await guardian.waitForAttempt();
  expect(attempt.request.target).toEqual({ type: 'domain', value: 'www.youtube.com' });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
});

test('in whitelist mode a typed data: page cannot frame other sites', async ({
  extension,
  guardian,
}) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { whitelistOnly: true, minutes: 60, reason: 'Examen' });

  const page = await extension.context.newPage();
  await page
    .goto('data:text/html,<iframe src="https://example.org/" width="1200" height="700"></iframe>')
    .catch(() => undefined);
  await expect(page).toHaveURL(blockedUrl({ cause: 'whitelist', enforced: true }));
  const info = (await extension.blockedTabs()).find((i) => i.cause === 'whitelist');
  expect(info).toMatchObject({ status: 'enforced', host: null, url: null });
  expect(guardian.attempts()).toEqual([]);
});

test('an open tab whose move the user cancelled («¿Salir del sitio?») is moved again', async ({
  extension,
  guardian,
}) => {
  test.setTimeout(90_000);
  await extension.pair(guardian);
  const page: Page = await extension.open('https://www.example.org/borrador');
  await page.setContent(
    `<textarea></textarea><script>
       addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
     </script>`,
  );
  // Sticky user activation: the browser only asks before leaving after an interaction.
  await page.locator('textarea').fill('Un borrador sin guardar');
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void (dialogs === 1 ? dialog.dismiss() : dialog.accept());
  });

  await addBlockAndWait(guardian, { domains: ['example.org'], minutes: 25, reason: REASON });
  await expect.poll(() => dialogs).toBe(1);
  await expect(page).toHaveURL('https://www.example.org/borrador');

  // The next 30 s tick (after the move's grace) asks again.
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', enforced: true }), {
    timeout: 60_000,
  });
  expect(dialogs).toBe(2);
  expect(guardian.attempts()).toEqual([]);
});
