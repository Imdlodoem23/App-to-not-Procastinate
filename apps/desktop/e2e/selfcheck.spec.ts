/**
 * The probes themselves: a check that cannot fail proves nothing. Injects known problems into
 * a running window and expects the layout probe and axe-core to report them (and nothing for
 * screen-reader-only text).
 */
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, probeLayout } from './support/checks';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterAll(async () => {
  await app?.close();
});

test('the layout probe reports clipped text, not screen-reader-only text', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  expect((await probeLayout(main)).clipped).toEqual([]);

  await main.evaluate(() => {
    const host = document.querySelector('[data-scroll-root]') ?? document.body;
    const fit = document.createElement('div');
    fit.dataset['fit'] = '';
    fit.id = 'probe-fit';
    fit.style.cssText = 'width: 60px; white-space: nowrap;';
    fit.textContent = 'Un texto demasiado largo para su caja';
    const hidden = document.createElement('div');
    hidden.id = 'probe-hidden';
    hidden.style.cssText = 'width: 60px; height: 18px; overflow: hidden;';
    hidden.textContent = 'Texto que se sale de su caja por abajo y por la derecha también';
    const srOnly = document.createElement('span');
    srOnly.className = 'sr-only';
    srOnly.textContent = 'Solo para lectores de pantalla, aunque sea muy largo';
    host.append(fit, hidden, srOnly);
  });
  const clipped = (await probeLayout(main)).clipped.map((c) => `${c.element}:${c.axis}`);
  expect(clipped).toContain('div#probe-fit:x');
  expect(clipped.some((c) => c.startsWith('div#probe-hidden'))).toBe(true);
  expect(clipped.some((c) => c.includes('sr-only'))).toBe(false);
});

test('axe-core runs in the page and reports a nameless button', async () => {
  const launched = app ?? (await launchApp({ state: 'idle', show: true }));
  app = launched;
  const main = await launched.page('main');
  await main.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'probe-nameless';
    document.querySelector('main')?.append(button);
  });
  const violations = await axeViolations(main);
  const buttonName = violations.find((v) => v.id === 'button-name');
  expect(buttonName?.nodes.map((n) => n.target)).toContain('#probe-nameless');
});
