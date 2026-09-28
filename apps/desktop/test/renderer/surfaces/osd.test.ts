import { describe, expect, it } from 'vitest';
import { fixtureInLocale, harnessFixture } from '../../../src/shared/fixtures';
import { OSD_LAYOUT } from '../../../src/shared/platform';
import { deriveOsdView } from '../../../src/renderer/src/windows/osd/view';

describe('OSD', () => {
  it('shows the fixture notice: «+15 min · hasta las 17:57» with the orange extend icon', () => {
    expect(deriveOsdView(harnessFixture('osd').snapshot)).toEqual({
      id: 1,
      text: '+15 min · hasta las 17:57',
      icon: 'extend',
      tone: 'orange',
    });
  });

  it('shows the notice as main worded it in English', () => {
    const fixture = fixtureInLocale(harnessFixture('osd'), 'en');
    expect(deriveOsdView(fixture.snapshot)?.text).toBe('+15 min · until 5:57 PM');
  });

  it('draws nothing without a notice (or with a blank one)', () => {
    expect(deriveOsdView({ osd: null })).toBeNull();
    expect(
      deriveOsdView({ osd: { id: 2, text: '   ', icon: 'check', tone: 'green', shownAt: 0 } }),
    ).toBeNull();
  });

  it('keeps the brief geometry: radius 8, 28 px text, 300 DIP above the bottom', () => {
    expect(OSD_LAYOUT).toEqual({ bottomOffset: 300, radius: 8, fontSize: 28 });
  });
});
