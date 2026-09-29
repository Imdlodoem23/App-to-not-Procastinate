/**
 * Section loop «Ampliar con deshacer» (PROMPT.md §10: extending is one click and reaches the
 * guardian only after the 5 s undo): a running block, «+15 min», the line «+15 min · termina
 * … · Deshacer (5 s)» counting down with the clock, «Deshacer», and the block as it was.
 *
 * Frame by frame on the harness (fake guardian, frozen clock moved one second per second of
 * video). Writes `frames/extend-undo/` to MARKETING_OUT.
 */
import { test, expect } from '@playwright/test';
import { CONFIG, LANG, freshDir, video, wanted } from './lib/config';
import { checkFont, launchDesktop, settled } from './lib/desktop';
import { FrameRecorder, assertNeutralIcons } from './lib/recorder';

const SPEC = video('extend-undo');

test('extend-undo', async () => {
  test.skip(!wanted(SPEC.id), 'not in MARKETING_ONLY');
  const dir = freshDir('frames', SPEC.id);
  const app = await launchDesktop('one-block', SPEC.theme);
  try {
    const font = await checkFont(app);
    const main = await app.page('main');
    const rec = await FrameRecorder.start(main, dir, {
      fps: CONFIG.fps,
      beforeCapture: () => settled(app),
      check: () => assertNeutralIcons(main, { requireSwitch: true }),
    });
    /** One second of video: the frame now, then the clock moves on. */
    const second = async (label: string | null = null): Promise<void> => {
      await rec.hold(1_000, label);
      await app.harness.advance(1_000);
    };
    // Clicks leave no pointer and no hover behind (the video has no cursor).
    const press = async (name: RegExp): Promise<void> => {
      await main.getByRole('button', { name }).click();
      await main.mouse.move(0, 0);
    };

    await second('start');
    await press(/^\+15 min$/);
    const undo = main.getByRole('button', { name: /^(Deshacer|Undo)\b/ });
    await expect(undo).toBeVisible();
    await rec.animate();
    await second('undo');
    await second();
    await second();
    await press(/^(Deshacer|Undo)\b/);
    await expect(undo).toHaveCount(0);
    await rec.animate();
    await second('undone');
    await rec.hold(800);

    rec.finish({
      id: SPEC.id,
      lang: LANG,
      theme: SPEC.theme,
      backdrop: SPEC.backdrop,
      anchor: 'bottom',
      scaleFactor: CONFIG.scaleFactor,
      font,
    });
  } finally {
    await app.close();
  }
});
