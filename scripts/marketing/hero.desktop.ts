/**
 * Hero video (PROMPT.md §11, home «Hero»): you type «no veo YouTube en una hora», Enter shows
 * the confirmation, Enter again starts the countdown, which then ticks for a few seconds.
 * About 9 s, played once on the web.
 *
 * Frame by frame on the harness (fake guardian, frozen clock): one screenshot per key, the
 * clock moved one second per countdown step. Writes `frames/hero/` to MARKETING_OUT.
 */
import { test, expect } from '@playwright/test';
import { CONFIG, LANG, freshDir, video, wanted } from './lib/config';
import { checkFont, launchDesktop, settled } from './lib/desktop';
import { FrameRecorder, assertNeutralIcons } from './lib/recorder';

const SPEC = video('hero');
/** The parser reads Spanish phrases in either UI language. */
const PHRASE = 'no veo YouTube en una hora';

/** Milliseconds each typed character stays on screen: steady, a little slower after words. */
function keyDelay(char: string, index: number): number {
  if (char === ' ') return 130;
  return 70 + ((index * 37) % 3) * 12;
}

test('hero', async () => {
  test.skip(!wanted(SPEC.id), 'not in MARKETING_ONLY');
  const dir = freshDir('frames', SPEC.id);
  const app = await launchDesktop('idle', SPEC.theme);
  try {
    const font = await checkFont(app);
    const main = await app.page('main');
    const rec = await FrameRecorder.start(main, dir, {
      fps: CONFIG.fps,
      beforeCapture: () => settled(app),
      // Idle, the typed phrase with its YouTube chip, the card, the countdown.
      check: () => assertNeutralIcons(main, { requireSwitch: true }),
    });

    // «¿Qué quieres hacer?», the only text field at rest (in either language).
    const field = main.getByRole('textbox');
    await field.focus();
    // The caret does not blink in these captures (lib/desktop.ts), so it shows while typing.
    await rec.hold(900, 'idle', 'initial');

    let typed = '';
    for (const [index, char] of [...PHRASE].entries()) {
      await main.keyboard.type(char);
      typed += char;
      await expect(field).toHaveValue(typed);
      await rec.animate(1_000, 'initial');
      await rec.hold(keyDelay(char, index), null, 'initial');
    }
    await rec.hold(700, 'typed', 'initial');

    await main.keyboard.press('Enter');
    // The card's confirm button («Bloquear hasta 18:00») takes the focus.
    await expect(main.locator('button:focus')).toHaveCount(1);
    await rec.animate();
    await rec.hold(1_500, 'confirm');

    await main.keyboard.press('Enter');
    const countdown = main.getByRole('timer').first();
    await expect(countdown).toHaveText('1:00:00');
    await rec.animate();
    await rec.hold(1_000, 'countdown');
    for (let tick = 0; tick < 4; tick += 1) {
      await app.harness.advance(1_000);
      await rec.hold(1_000);
    }

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
