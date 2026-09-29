/**
 * The probes themselves: a check that cannot fail proves nothing. Injects known problems into
 * a running window and expects the layout probe and axe-core to report them (and nothing for
 * screen-reader-only text).
 */
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, probeLayout } from './support/checks';
import { auditKeyboard, liveEvents, watchLiveRegions } from './support/keyboard';
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

test('the keyboard audit reports small or covered targets, broken descriptions, shortcuts and late live regions', async () => {
  const launched = await launchApp({ state: 'idle', show: true });
  const main = await launched.page('main');
  try {
    await watchLiveRegions(main);
    await main.evaluate(() => {
      const host = document.querySelector('main') ?? document.body;
      const box = document.createElement('div');
      box.style.cssText = 'position: relative; display: flex; gap: 0; padding: 40px 0;';
      // 24×24: too small.
      const small = document.createElement('button');
      small.id = 'probe-small';
      small.textContent = 'x';
      small.style.cssText = 'width: 24px; height: 24px; padding: 0;';
      small.setAttribute('aria-describedby', 'probe-missing');
      small.setAttribute('aria-keyshortcuts', 'Alt+Q');
      // 80×40, but a later positioned box covers its top half.
      const covered = document.createElement('button');
      covered.id = 'probe-covered';
      covered.textContent = 'Tapado';
      covered.style.cssText = 'width: 80px; height: 40px;';
      covered.setAttribute('aria-keyshortcuts', 'alt+q');
      const cover = document.createElement('div');
      cover.style.cssText = 'position: absolute; left: 24px; top: 40px; width: 80px; height: 20px;';
      const tile = document.createElement('button');
      tile.className = 'c-tile';
      tile.id = 'probe-tile';
      tile.textContent = 'Tile sin atajo';
      box.append(small, covered, tile, cover);
      host.append(box);
      // A live region that appears with its text, and one that gains aria-live.
      const late = document.createElement('div');
      late.setAttribute('role', 'status');
      late.textContent = 'Hecho';
      host.append(late);
      document.querySelector('footer')?.setAttribute('aria-live', 'polite');
    });
    const audit = await auditKeyboard(main);
    const targets = audit.smallTargets.map((t) => t.element);
    expect(targets.some((t) => t.startsWith('button#probe-small'))).toBe(true);
    expect(targets.some((t) => t.startsWith('button#probe-covered'))).toBe(true);
    expect(audit.brokenDescribedBy.map((d) => d.missing)).toContainEqual(['probe-missing']);
    expect(audit.duplicateShortcuts.map((d) => d.shortcut)).toContain('alt+q');
    expect(audit.tilesWithoutShortcut.some((t) => t.startsWith('button#probe-tile'))).toBe(true);
    const events = (await liveEvents(main)).map((e) => e.kind);
    expect(events).toContain('mounted');
    expect(events).toContain('gained');
  } finally {
    await launched.close();
  }
});
