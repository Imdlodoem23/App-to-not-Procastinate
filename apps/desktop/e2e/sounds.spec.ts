/**
 * Concentration sounds (PROMPT §9 «Sonidos de concentración (lluvia, ruido blanco, lo-fi) que
 * funcionan sin internet»; docs/DESKTOP.md §15.2): the main window's `MainWindowFeature` plays
 * `prefs.sounds.ambient` from `resources/sounds/` through Web Audio, in a real run (mock guardian,
 * `sounds:load` from main). Harness runs stay silent by design (screenshots, no audio device).
 *
 * The page's `AudioContext` is wrapped to record what the player does: no context before a
 * sound is picked, one looping buffer per pick (switching fades the old one out as the new one
 * starts), and a stop on «Nada».
 */
import type { Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './support/app';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

type AudioLog = { __audio: string[] };

/** Records context creation, loop starts and stops from now on. */
async function recordAudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as AudioLog & { AudioContext: typeof AudioContext };
    g.__audio = [];
    const Original = g.AudioContext;
    g.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        g.__audio.push('context');
      }
      override createBufferSource(): AudioBufferSourceNode {
        const node = super.createBufferSource();
        const start = node.start.bind(node);
        const stop = node.stop.bind(node);
        node.start = (...args: Parameters<AudioBufferSourceNode['start']>) => {
          g.__audio.push(
            `start ${node.loop ? 'loop' : 'once'} ${node.buffer ? 'buffer' : 'empty'}`,
          );
          start(...args);
        };
        node.stop = (...args: Parameters<AudioBufferSourceNode['stop']>) => {
          g.__audio.push('stop');
          stop(...args);
        };
        return node;
      }
    } as typeof AudioContext;
  });
}

function audioLog(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(globalThis as unknown as AudioLog).__audio]);
}

async function pick(page: Page, ambient: 'none' | 'rain' | 'white-noise' | 'lofi'): Promise<void> {
  const ok = await page.evaluate(async (sound) => {
    const bridge = (
      globalThis as unknown as {
        centrate: { invoke(channel: string, req: unknown): Promise<{ ok: boolean }> };
      }
    ).centrate;
    return (await bridge.invoke('prefs:set', { sounds: { ambient: sound } })).ok;
  }, ambient);
  expect(ok).toBe(true);
}

test('picking a sound plays it on a loop, switching crossfades, «Nada» stops it', async () => {
  app = await launchApp({ state: null });
  const main = await app.page('main');
  await recordAudio(main);
  // Silence costs nothing: no context until a sound is picked.
  await main.waitForTimeout(300);
  expect(await audioLog(main)).toEqual([]);

  await pick(main, 'rain');
  await expect
    .poll(() => audioLog(main), { timeout: 15_000 })
    .toEqual(['context', 'start loop buffer']);

  await pick(main, 'lofi');
  await expect
    .poll(() => audioLog(main), { timeout: 15_000 })
    .toEqual(['context', 'start loop buffer', 'stop', 'start loop buffer']);

  await pick(main, 'none');
  await expect
    .poll(() => audioLog(main), { timeout: 5_000 })
    .toEqual(['context', 'start loop buffer', 'stop', 'start loop buffer', 'stop']);
});
