import { describe, expect, it } from 'vitest';
import type { BlockedPageParams } from '../../src/background/rules';
import {
  INFO_FRESH_MS,
  backAction,
  blockedSubject,
  blockedView,
  humorLine,
  isCurrentInfo,
  pointsLine,
  reopenUrl,
  shownBlock,
  stillEnforced,
} from '../../src/pages/blocked/model';
import { PAGES_ES } from '../../src/pages/i18n/es';
import { popupTimes, blockSection } from '../../src/pages/popup/model';
import { createEndAnnouncer } from '../../src/pages/shared/phase';
import { MIN, NOW, iso, ruleBlock, snapshot, tabInfo } from './fixtures';

const YT: BlockedPageParams = { cause: 'domain', serviceId: 'youtube', enforced: false };
const NONE: BlockedPageParams = { cause: 'domain', serviceId: null, enforced: false };
const WL: BlockedPageParams = { cause: 'whitelist', serviceId: null, enforced: false };

const ctx = (over: Partial<Parameters<typeof isCurrentInfo>[1]> = {}) => ({
  tabId: 7,
  params: YT,
  loadedAt: NOW,
  navigationType: 'navigate',
  ...over,
});

describe('isCurrentInfo', () => {
  it('accepts the info of this tab and this site', () => {
    expect(isCurrentInfo(tabInfo(), ctx())).toBe(true);
    // Written just before the extension moved the tab here.
    expect(isCurrentInfo(tabInfo({ at: NOW - 2_000, status: 'enforced' }), ctx())).toBe(true);
  });

  it('refuses another tab, another site, another cause or an unknown tab', () => {
    expect(isCurrentInfo(null, ctx())).toBe(false);
    expect(isCurrentInfo(tabInfo({ tabId: 8 }), ctx())).toBe(false);
    expect(isCurrentInfo(tabInfo(), ctx({ tabId: null }))).toBe(false);
    expect(isCurrentInfo(tabInfo({ serviceId: 'reddit' }), ctx())).toBe(false);
    expect(isCurrentInfo(tabInfo({ cause: 'whitelist' }), ctx())).toBe(false);
  });

  it('refuses stale info from an earlier page, except on a reload or back/forward', () => {
    const old = tabInfo({ at: NOW - INFO_FRESH_MS - 1 });
    expect(isCurrentInfo(old, ctx())).toBe(false);
    expect(isCurrentInfo(old, ctx({ navigationType: 'reload' }))).toBe(true);
    expect(isCurrentInfo(old, ctx({ navigationType: 'back_forward' }))).toBe(true);
  });
});

describe('blockedSubject', () => {
  it('names the catalog service, else the host, else «Esta web»', () => {
    expect(blockedSubject(YT, null)).toMatchObject({ name: 'YouTube', known: true });
    expect(
      blockedSubject(WL, tabInfo({ cause: 'whitelist', serviceId: null, host: 'www.example.org' })),
    ).toMatchObject({ name: 'example.org', known: true });
    expect(blockedSubject(NONE, null)).toEqual({
      name: 'Esta web',
      inlineName: 'esta web',
      known: false,
    });
    // A made-up id in the query string is not a service.
    expect(blockedSubject({ ...YT, serviceId: 'not-a-service' }, null).known).toBe(false);
  });
});

describe('shownBlock', () => {
  it('uses the live version of the attempt block (an extension shows at once)', () => {
    const extended = ruleBlock({ endsAt: iso(NOW + 73 * MIN), reason: 'Aprobar mates' });
    const shown = shownBlock(YT, tabInfo(), snapshot({ blocks: [extended] }));
    expect(shown?.endsAt).toBe(NOW + 73 * MIN);
    expect(shown?.reason).toBe('Aprobar mates');
  });

  it('keeps the attempt block when the snapshot no longer has it', () => {
    const shown = shownBlock(YT, tabInfo(), snapshot({ blocks: [] }));
    expect(shown?.endsAt).toBe(NOW + 43 * MIN);
  });

  it('shows the covering block that ends last', () => {
    const later = ruleBlock({
      id: 'blk_later',
      endsAt: iso(NOW + 90 * MIN),
      reason: 'Terminar el TFG',
      mode: 'hardcore',
    });
    const other = ruleBlock({
      id: 'blk_other',
      serviceIds: ['reddit'],
      domains: ['reddit.com'],
      endsAt: iso(NOW + 200 * MIN),
    });
    const shown = shownBlock(YT, tabInfo(), snapshot({ blocks: [ruleBlock(), later, other] }));
    expect(shown).toMatchObject({ endsAt: NOW + 90 * MIN, reason: 'Terminar el TFG' });
  });

  it('finds the block from the query string alone (frames, reloads without info)', () => {
    expect(shownBlock(YT, null, snapshot())?.reason).toBe('Aprobar mates');
    expect(shownBlock(NONE, null, snapshot())).toBeNull();
    expect(shownBlock(YT, null, null)).toBeNull();
  });

  it('whitelist pages use whitelist blocks, then the punishment', () => {
    const exam = ruleBlock({
      id: 'blk_exam',
      mode: 'exam',
      whitelistOnly: true,
      serviceIds: [],
      domains: [],
      reason: 'Examen de historia',
    });
    expect(shownBlock(WL, null, snapshot({ blocks: [ruleBlock(), exam] }))?.reason).toBe(
      'Examen de historia',
    );
    const punished = shownBlock(
      WL,
      null,
      snapshot({ blocks: [], punishment: { endsAt: iso(NOW + 30 * MIN), level: 'whitelist' } }),
    );
    expect(punished).toEqual({
      endsAt: NOW + 30 * MIN,
      reason: null,
      mode: 'hardcore',
      kind: 'punishment',
    });
  });

  it('treats an empty reason as none', () => {
    expect(shownBlock(YT, null, snapshot({ blocks: [ruleBlock({ reason: '  ' })] }))?.reason).toBe(
      null,
    );
  });
});

describe('pointsLine', () => {
  it('shows what the attempt cost, in red', () => {
    expect(pointsLine(tabInfo())).toEqual({ text: '−10 puntos', tone: 'red', note: null });
  });

  it('keeps the line while the guardian answers', () => {
    expect(pointsLine(tabInfo({ status: 'reporting', pointsDelta: null }))).toBe('pending');
  });

  it('a reload or a second tab shows the attempt it belongs to, without a new charge', () => {
    const merged = pointsLine(
      tabInfo({ status: 'merged', pointsDelta: 0, episodePointsDelta: -20 }),
    );
    expect(merged).toEqual({
      text: '−20 puntos',
      tone: 'red',
      note: PAGES_ES.blocked.sameAttempt,
    });
    expect(pointsLine(tabInfo({ status: 'ignored', episodePointsDelta: -10 }))).toMatchObject({
      text: '−10 puntos',
    });
  });

  it('omits points when unknown, not counted or free', () => {
    expect(pointsLine(null)).toBeNull();
    expect(pointsLine(tabInfo({ status: 'unreported', pointsDelta: null }))).toBeNull();
    expect(pointsLine(tabInfo({ status: 'not_counted', pointsDelta: 0 }))).toBeNull();
    // Penalties off: counted, nothing charged.
    expect(pointsLine(tabInfo({ status: 'counted', pointsDelta: 0 }))).toBeNull();
    expect(pointsLine(tabInfo({ status: 'ignored', episodePointsDelta: null }))).toBeNull();
  });

  it('a tab moved here is not an attempt, and says so in grey', () => {
    expect(pointsLine(tabInfo({ status: 'enforced', pointsDelta: 0 }))).toEqual({
      text: PAGES_ES.blocked.enforced,
      tone: 'muted',
      note: null,
    });
  });
});

describe('humorLine', () => {
  const subject = { name: 'YouTube', inlineName: 'YouTube', known: true };

  it('rotates lines that use the time left', () => {
    const lines = new Set(
      [0, 1, 2, 3, 4].map((i) =>
        humorLine(i, { subject, remainingMs: 43 * MIN, cause: 'domain', mode: 'strict' }),
      ),
    );
    expect(lines.size).toBe(5);
    expect(lines).toContain('YouTube seguirá ahí dentro de 43 minutos. Tus deberes, no.');
  });

  it('skips time lines when the end is unknown, and never breaks on odd indexes', () => {
    for (const i of [0, 1, 2, 3, 7, -3, 1e9]) {
      const line = humorLine(i, { subject, remainingMs: null, cause: 'domain', mode: null });
      expect(line).not.toMatch(/minuto|hora/);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('uses the lowercase name inside sentences', () => {
    const unknown = { name: 'Esta web', inlineName: 'esta web', known: false };
    const lines = [0, 1, 2, 3, 4].map((i) =>
      humorLine(i, { subject: unknown, remainingMs: null, cause: 'domain', mode: null }),
    );
    expect(lines.join(' ')).not.toMatch(/\bgracias a Esta web/);
  });

  it('has its own lines for the exam, other whitelists and the end', () => {
    expect(humorLine(0, { subject, remainingMs: MIN, cause: 'whitelist', mode: 'exam' })).toBe(
      PAGES_ES.blocked.examLine,
    );
    expect(humorLine(0, { subject, remainingMs: MIN, cause: 'whitelist', mode: 'hardcore' })).toBe(
      PAGES_ES.blocked.whitelistLine,
    );
    expect(humorLine(3, { subject, remainingMs: 0, cause: 'domain', mode: 'normal' })).toBe(
      PAGES_ES.blocked.endedLine,
    );
  });
});

describe('backAction', () => {
  const base = { historyLength: 3, params: YT, info: tabInfo(), loadedAt: NOW };

  it('goes back after a redirect (the previous page is not the blocked site)', () => {
    expect(backAction(base)).toBe('history');
    expect(backAction({ ...base, info: null })).toBe('history');
  });

  it('opens a new tab when there is no history', () => {
    expect(backAction({ ...base, historyLength: 1 })).toBe('newtab');
  });

  it('never goes back when the extension moved this tab here (the previous entry is the site)', () => {
    expect(backAction({ ...base, params: { ...YT, enforced: true } })).toBe('newtab');
    expect(backAction({ ...base, info: tabInfo({ status: 'enforced' }) })).toBe('newtab');
    // The safety net wrote the info before this page started loading.
    expect(backAction({ ...base, info: tabInfo({ at: NOW - 5 }) })).toBe('newtab');
  });
});

describe('stillEnforced', () => {
  const ended = ruleBlock({ endsAt: iso(NOW - MIN) });

  it('the snapshot still lists a block over the site: the guardian holds it', () => {
    expect(stillEnforced(YT, tabInfo(), snapshot({ blocks: [ended] }))).toBe(true);
    // Found by the attempt's block id, or by covering the site.
    expect(stillEnforced(YT, null, snapshot({ blocks: [ended] }))).toBe(true);
    expect(
      stillEnforced(YT, tabInfo(), snapshot({ blocks: [ruleBlock({ id: 'blk_other' })] })),
    ).toBe(true);
  });

  it('the snapshot is not known yet: it may still be enforced', () => {
    expect(stillEnforced(YT, tabInfo(), null)).toBe(true);
  });

  it('nothing over the site any more', () => {
    expect(stillEnforced(YT, tabInfo(), snapshot({ blocks: [] }))).toBe(false);
    expect(stillEnforced(YT, tabInfo(), snapshot({ rules: null }))).toBe(false);
    const reddit = ruleBlock({ id: 'blk_r', serviceIds: ['reddit'], domains: ['reddit.com'] });
    expect(stillEnforced(YT, tabInfo(), snapshot({ blocks: [reddit] }))).toBe(false);
  });

  it('a whitelist page is held by the punishment too', () => {
    const wl = tabInfo({ cause: 'whitelist', serviceId: null, host: 'example.org', block: null });
    const punishment = { endsAt: iso(NOW - MIN), level: 'whitelist' as const };
    expect(stillEnforced(WL, wl, snapshot({ blocks: [], punishment }))).toBe(true);
    expect(stillEnforced(WL, wl, snapshot({ blocks: [] }))).toBe(false);
  });
});

describe('reopenUrl', () => {
  const free = snapshot({ blocks: [] });

  it('reopens the http(s) page the attempt wanted', () => {
    expect(reopenUrl(tabInfo(), free)).toBe('https://www.youtube.com/watch?v=1');
    expect(reopenUrl(tabInfo({ url: 'http://example.org/a?b=1#c' }), free)).toBe(
      'http://example.org/a?b=1#c',
    );
  });

  it('never another scheme, an unreadable or unknown URL', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'x']) {
      expect(reopenUrl(tabInfo({ url }), free)).toBeNull();
    }
    expect(reopenUrl(tabInfo({ url: null }), free)).toBeNull();
    expect(reopenUrl(null, free)).toBeNull();
  });

  it('not while a whitelist may redirect it again, nor without a snapshot', () => {
    const whitelist = snapshot({ blocks: [] });
    if (whitelist.rules !== null) whitelist.rules.whitelistActive = true;
    expect(reopenUrl(tabInfo(), whitelist)).toBeNull();
    expect(reopenUrl(tabInfo(), null)).toBeNull();
  });
});

describe('blockedView', () => {
  const input = {
    params: YT,
    info: tabInfo(),
    snapshot: snapshot(),
    now: NOW + 17_000,
    humorIndex: 0,
    ready: true,
  };

  it('renders «YouTube: bloqueado» · «quedan 43 min», the reason and «−10 puntos»', () => {
    const view = blockedView(input);
    expect(view.phase).toBe('blocked');
    expect(view.title).toBe('YouTube: bloqueado');
    expect(view.documentTitle).toBe('YouTube: bloqueado · Céntrate');
    expect(view.headerValue).toBe('quedan 43 min');
    expect(view.remainingLabel).toBe('Quedan 43 minutos');
    expect(view.reason).toBe('Aprobar mates');
    expect(view.points).toMatchObject({ text: '−10 puntos' });
    expect(view.humor).toBe('YouTube seguirá ahí dentro de 43 minutos. Tus deberes, no.');
    expect(view.action).toEqual({ kind: 'back' });
    expect(view.actionLabel).toBe('Volver a lo mío');
    // Next change: when «quedan 43 min» becomes «quedan 42 min».
    expect(view.nextTickMs).toBe(43_004);
  });

  it('shows one minute count: the header and the humor line always agree', () => {
    for (const offset of [17_000, 50_000, 59_999, 60_000, 61_000, 42 * MIN + 1_000]) {
      const view = blockedView({ ...input, now: NOW + offset });
      const minutes = /quedan? (\d+) min/.exec(view.headerValue ?? '')?.[1];
      expect(minutes, `offset ${offset}`).toBeDefined();
      expect(view.humor).toMatch(new RegExp(`dentro de ${minutes} minutos?\\.`));
    }
  });

  it('has no seconds countdown (PROMPT §10: only «quedan N min»)', () => {
    expect(Object.keys(blockedView(input))).not.toContain('countdown');
  });

  it('holds the humor line until the first answers arrived', () => {
    expect(blockedView({ ...input, ready: false }).humor).toBe('');
  });

  it('end passed but the block still enforced: «Comprobando la hora…», never «terminado»', () => {
    const held = snapshot({ blocks: [ruleBlock()] });
    const view = blockedView({ ...input, snapshot: held, now: NOW + 44 * MIN });
    expect(view).toMatchObject({
      phase: 'checking',
      title: 'YouTube: bloqueado',
      headerValue: 'Comprobando la hora…',
      remainingLabel: null,
      remainingMs: 0,
      reason: 'Aprobar mates',
      points: { text: '−10 puntos' },
      humor: 'Podrás entrar en YouTube en cuanto Céntrate confirme la hora.',
      action: { kind: 'back' },
      actionLabel: 'Volver a lo mío',
      nextTickMs: null,
    });
    expect(`${view.title} ${view.humor}`).not.toMatch(/terminad/);
    // Before the snapshot arrives nothing is known either.
    expect(blockedView({ ...input, snapshot: null, now: NOW + 44 * MIN }).phase).toBe('checking');
  });

  it('once nothing covers the site: «Abrir YouTube» reopens it, no reason or points', () => {
    const view = blockedView({ ...input, snapshot: snapshot({ blocks: [] }), now: NOW + 44 * MIN });
    expect(view).toMatchObject({
      phase: 'ended',
      title: 'YouTube: bloqueo terminado',
      headerValue: null,
      remainingMs: 0,
      reason: null,
      points: null,
      humor: 'Ya puedes volver a entrar.',
      action: { kind: 'open', url: 'https://www.youtube.com/watch?v=1' },
      actionLabel: 'Abrir YouTube',
      nextTickMs: null,
    });
    // The line does not repeat the title.
    expect(view.humor).not.toMatch(/terminad/);
  });

  it('ended without a URL to reopen: «Volver a lo mío» stays', () => {
    const free = snapshot({ blocks: [] });
    const later = NOW + 44 * MIN;
    for (const info of [tabInfo({ url: null }), tabInfo({ url: 'chrome://settings' })]) {
      const view = blockedView({ ...input, info, snapshot: free, now: later });
      expect(view.phase).toBe('ended');
      expect(view.action).toEqual({ kind: 'back' });
      expect(view.actionLabel).toBe('Volver a lo mío');
    }
  });

  it('opened by hand: a neutral page with no time, reason or points', () => {
    const view = blockedView({ ...input, params: NONE, info: null, snapshot: null });
    expect(view).toMatchObject({
      phase: 'blocked',
      title: 'Esta web: bloqueada',
      headerValue: null,
      remainingLabel: null,
      reason: null,
      points: null,
      action: { kind: 'back' },
      nextTickMs: null,
    });
  });
});

describe('blockedView: the live region', () => {
  const input = {
    params: YT,
    info: tabInfo(),
    snapshot: snapshot(),
    now: NOW + 17_000,
    humorIndex: 0,
    ready: true,
  };

  it('follows the minutes while blocked, and stays silent until the first answers', () => {
    expect(blockedView(input).announce).toEqual({
      kind: 'counting',
      key: 'site',
      remainingMs: 43 * MIN - 17_000,
    });
    expect(blockedView({ ...input, ready: false }).announce).toEqual({ kind: 'none' });
  });

  it('an ended block still listed is «checking»: silent, not «Bloqueo terminado»', () => {
    // Ended 30 s ago, the snapshot still lists it (boot hold or new rules on their way).
    const view = blockedView({ ...input, now: NOW + 43 * MIN + 30_000 });
    expect(view.phase).toBe('checking');
    expect(view.headerValue).toBe(PAGES_ES.blocked.checking);
    expect(view.announce).toEqual({ kind: 'checking', key: 'site' });
    // Without the snapshot nothing is known yet: silent, and nothing to announce later.
    const unknown = blockedView({ ...input, snapshot: null, now: NOW + 44 * MIN });
    expect(unknown.phase).toBe('checking');
    expect(unknown.announce).toEqual({ kind: 'none' });
    expect(
      blockedView({ ...input, snapshot: snapshot({ blocks: [] }), now: NOW + 44 * MIN }),
    ).toMatchObject({ phase: 'ended', announce: { kind: 'ended' } });
  });

  it('speaks «Bloqueo terminado» on the move to `ended`, not when the time crosses 0', () => {
    const announcer = createEndAnnouncer();
    const said = (over: Partial<typeof input>): string | null =>
      announcer.next(blockedView({ ...input, ...over }).announce);
    expect(said({ now: NOW + 41 * MIN })).toBeNull();
    expect(said({ now: NOW + 42 * MIN + 30_000 })).toBe('Queda 1 minuto');
    expect(said({ now: NOW + 43 * MIN })).toBeNull();
    expect(said({ now: NOW + 43 * MIN + 30_000 })).toBeNull();
    expect(said({ now: NOW + 44 * MIN, snapshot: snapshot({ blocks: [] }) })).toBe(
      'Bloqueo terminado',
    );
  });

  it('a page loaded after the end stays silent when the snapshot lands', () => {
    const announcer = createEndAnnouncer();
    const late = NOW + 50 * MIN;
    for (const over of [
      { ready: false, snapshot: null },
      { snapshot: null },
      { snapshot: snapshot({ blocks: [] }) },
    ]) {
      expect(announcer.next(blockedView({ ...input, ...over, now: late }).announce)).toBeNull();
    }
  });

  it('agrees with the popup on an ended block still listed', () => {
    const now = NOW + 43 * MIN + 30_000;
    const held = snapshot();
    const page = blockedView({ ...input, snapshot: held, now });
    const popup = popupTimes(blockSection(held), now);
    expect(page.headerValue).toBe(PAGES_ES.blocked.checking);
    expect(popup.until).toBe(page.headerValue);
    expect(popup.countdownMs).toBeNull();
    expect([page.announce.kind, popup.announce.kind]).toEqual(['checking', 'checking']);
  });
});
