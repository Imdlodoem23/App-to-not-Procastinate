/**
 * The pages' English copy (same rules as the Spanish, PROMPT §10): sentence case, the
 * typographic minus, no Spanish left over, humor only on the blocked page, and the browsers'
 * own English labels in the guide.
 */
import { describe, expect, it } from 'vitest';
import { PAGES_EN } from '../../src/pages/i18n/en';
import { PAGES_ES } from '../../src/pages/i18n/es';

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) strings(v, out);
  }
  return out;
}

describe('English copy', () => {
  const all = strings(PAGES_EN);

  it('never writes a hyphen as a minus sign', () => {
    for (const s of all) expect(s).not.toMatch(/(^|\s)-\d/);
  });

  it('uses sentence case (no Title Case Words after the first)', () => {
    const titleCase = /^(?:[A-Z][a-z]+ ){2,}[A-Z][a-z]+$/;
    for (const s of all) expect(s).not.toMatch(titleCase);
  });

  it('leaves no Spanish behind (only the product name keeps its accent)', () => {
    for (const s of all) {
      expect(s.replaceAll('Céntrate', ''), s).not.toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡«»]/);
    }
    const spanish = new Set(strings(PAGES_ES));
    // Only names, browser ids and the releases link read the same in both languages.
    const shared =
      /^(?:Céntrate|Normal|Hardcore|, |https:\/\/\S+|chrome|chromium|edge|brave|opera|vivaldi|firefox)$/i;
    for (const s of all.filter((s) => spanish.has(s))) expect(s).toMatch(shared);
  });

  it('renders every humor line with and without a known end', () => {
    const context = { name: 'YouTube', inlineName: 'YouTube', time: '43 minutes' };
    for (const line of PAGES_EN.blocked.humor) {
      expect(line(context)).toMatch(/\.$/);
      const untimed = line({ ...context, time: null });
      if (untimed !== null) expect(untimed).not.toContain('null');
    }
    expect(
      PAGES_EN.blocked.humor.filter((line) => line({ ...context, time: null }) !== null).length,
    ).toBeGreaterThanOrEqual(2);
    const unknown = { name: 'This site', inlineName: 'this site', time: '1 hour and 5 minutes' };
    expect(PAGES_EN.blocked.humor[1]?.(unknown)).toBe(
      'This site can wait 1 hour and 5 minutes. Your work, not so much.',
    );
  });

  it('names private windows as each browser does, in English', () => {
    expect(PAGES_EN.common.privateName('chrome')).toBe('incognito');
    expect(PAGES_EN.common.privateName('edge')).toBe('InPrivate');
    expect(PAGES_EN.common.privateName('firefox')).toBe('private windows');
    const state = PAGES_EN.guide.incognito.state;
    expect(state('firefox', false)).toBe('Private windows: not allowed');
    expect(state('chrome', true)).toBe('Incognito: allowed');
    expect(state('edge', false)).toBe('InPrivate: not allowed');
    expect(PAGES_EN.notices.incognito_not_allowed('chrome')).toBe(
      'Nothing is blocked in incognito windows: allow the extension there.',
    );
    expect(PAGES_EN.notices.incognito_not_allowed('firefox')).toBe(
      'Nothing is blocked in private windows: allow the extension there.',
    );
  });

  it('headers never put a capital right after «Thing:» (sentence case, like the app)', () => {
    const header = PAGES_EN.popup.block(PAGES_EN.common.targets.whitelistShort, 'Exam');
    expect(header).toBe('Block: allowlist only · Exam');
    for (const level of Object.values(PAGES_EN.common.punishmentLevels)) {
      expect(PAGES_EN.popup.punishment(level)).toMatch(/^Punishment: [a-z]/);
    }
  });

  it("the install guide names each browser's own English labels and the right package", () => {
    const chromium = [...PAGES_EN.guide.chromium.steps, ...PAGES_EN.guide.chromium.notes].join(' ');
    expect(chromium).toContain('“Load unpacked”');
    expect(chromium).toContain('“Developer mode”');
    expect(chromium).toContain('Centrate-extension.zip');
    expect(chromium).not.toContain('firefox.zip');

    const firefox = [...PAGES_EN.guide.firefox.steps, ...PAGES_EN.guide.firefox.notes].join(' ');
    expect(firefox).toContain('about:addons, press ⚙ › “Install Add-on From File…”');
    expect(firefox).toContain(`“${PAGES_EN.guide.toc['host-permission']}”`);
    expect(firefox).toContain('about:debugging › This Firefox');
    expect(firefox).toContain('“Load Temporary Add-on…”');
    expect(firefox).toContain('Centrate-extension-firefox.zip');
    expect(firefox).not.toMatch(/Centrate-extension\.zip/);
    expect(`${firefox} ${chromium}`).not.toContain('store.zip');
    expect(firefox).toContain('“Run in Private Windows” to “Allow”');
    const firefoxPrivate = PAGES_EN.guide.incognito.browsers.find((b) =>
      b.families.includes('firefox'),
    );
    expect(firefoxPrivate?.steps).toContain('“Run in Private Windows”');
  });

  it('points the pairing errors at sections that exist in the guide', () => {
    expect(PAGES_EN.pairing.errors.peer_not_browser).toContain(
      `“${PAGES_EN.guide.toc.troubleshooting}”`,
    );
    expect(PAGES_EN.guide.troubleshooting.title).toBe(PAGES_EN.guide.toc.troubleshooting);
  });

  it('the privacy note says what leaves the browser: only the blocked domain', () => {
    const note = PAGES_EN.guide.privacy.points.join(' ');
    expect(note).toMatch(/never sends your browsing history/);
    expect(note).toMatch(/only when you try to open something blocked, it sends the domain/i);
    expect(note).toMatch(/never the full address/);
  });

  it('«Retry» says what it is doing and what it found', () => {
    expect(PAGES_EN.popup.retrying).toBe('Retrying…');
    expect(PAGES_EN.popup.retryStill(true, PAGES_EN.popup.checkedAt('5:42 PM'))).toBe(
      'Still not responding · checked at 5:42 PM',
    );
  });
});
