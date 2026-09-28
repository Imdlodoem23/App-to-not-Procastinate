/**
 * A blocked site opened through a server redirect (links in X via t.co, bit.ly, lnkd.in,
 * google.com/url in Gmail, l.facebook.com…) counts for that site, not for the redirector:
 * webNavigation.onBeforeNavigate only sees the first URL, so the background follows the
 * navigation's redirects with webRequest.onBeforeRedirect (background/attempts.ts,
 * docs/ARCHITECTURE.md §9.5).
 *
 * The redirector is a real 302 on 127.0.0.1 (loopback is not part of the fake web), so
 * Chromium follows it and declarativeNetRequest redirects the second hop to blocked.html.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addBlockAndWait, blockedUrl, expect, test as base } from './support/extension';
import { expectBlockedPage } from './support/pages';

const REASON = 'Terminar el trabajo de historia';

interface Redirector {
  /** `http://127.0.0.1:<port>/r?to=<target>`: answers 302 with `Location: <target>`. */
  link(target: string): string;
  /** Requests it answered (path and query). */
  readonly hits: string[];
}

const test = base.extend<{ redirector: Redirector }>({
  // eslint-disable-next-line no-empty-pattern
  redirector: async ({}, use) => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const to = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('to');
      if (to === null || !/^https?:\/\//.test(to)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await use({
      link: (target) => `http://127.0.0.1:${port}/r?to=${encodeURIComponent(target)}`,
      hits,
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
});

test('a link through a redirector (302) to YouTube costs the YouTube attempt', async ({
  extension,
  guardian,
  redirector,
}) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { services: ['youtube'], minutes: 25, reason: REASON });

  const page = await extension.open(redirector.link('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain', serviceId: 'youtube' }));
  expect(redirector.hits).toHaveLength(1);

  const attempt = await guardian.waitForAttempt();
  expect(attempt.request.target).toEqual({ type: 'domain', value: 'www.youtube.com' });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  await expectBlockedPage(page, {
    service: 'YouTube',
    reason: REASON,
    minutesLeft: [24, 25],
    points: '−10 puntos',
  });
  await expect
    .poll(async () => (await extension.blockedTabs()).map(({ host, status }) => ({ host, status })))
    .toEqual([{ host: 'www.youtube.com', status: 'counted' }]);
  expect(guardian.attempts()).toHaveLength(1);
});

test('a custom site behind a redirector is named on blocked.html, with its countdown', async ({
  extension,
  guardian,
  redirector,
}) => {
  await extension.pair(guardian);
  await addBlockAndWait(guardian, { domains: ['example.org'], minutes: 25, reason: REASON });

  const page = await extension.open(redirector.link('https://www.example.org/articulo'));
  await expect(page).toHaveURL(blockedUrl({ cause: 'domain' }));

  const attempt = await guardian.waitForAttempt();
  expect(attempt.request.target).toEqual({ type: 'domain', value: 'www.example.org' });
  expect(attempt.response).toMatchObject({ counted: true, pointsDelta: -10 });
  await expectBlockedPage(page, {
    service: 'example\\.org',
    reason: REASON,
    minutesLeft: [24, 25],
    points: '−10 puntos',
  });
  await expect(page.getByText('127.0.0.1')).toHaveCount(0);
});
