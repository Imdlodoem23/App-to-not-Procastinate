import { describe, expect, it } from 'vitest';
import { PAGES_ES } from '../../src/pages/i18n/es';
import { MAX_ROWS, blockSection, popupTimes } from '../../src/pages/popup/model';
import { formatUntil } from '../../src/pages/shared/format';
import { MIN, NOW, iso, ruleBlock, snapshot } from './fixtures';

const CHECKING = PAGES_ES.blocked.checking;

describe('blockSection', () => {
  it('hides the section when not paired and nothing is cached', () => {
    expect(blockSection(null)).toBeNull();
    expect(
      blockSection(
        snapshot({ paired: false, pairing: null, problems: ['not_paired'], rules: null }),
      ),
    ).toBeNull();
  });

  it('«Bloqueo: ninguno» with a hint when paired and idle', () => {
    expect(blockSection(snapshot({ blocks: [] }))).toMatchObject({
      title: 'Bloqueo: ninguno',
      endsAt: null,
      rows: [],
      more: 0,
      emptyHelp: expect.stringContaining('app Céntrate'),
    });
  });

  it('the title is the state: targets and mode of the block that ends last', () => {
    const section = blockSection(snapshot());
    expect(section).toMatchObject({
      title: 'Bloqueo: YouTube · Estricto',
      endsAt: NOW + 43 * MIN,
      accent: 'orange',
      reason: 'Aprobar mates',
      rows: [],
    });
  });

  it('offers shorter titles when many targets do not fit', () => {
    const section = blockSection(
      snapshot({
        blocks: [
          ruleBlock({
            serviceIds: ['youtube', 'instagram', 'tiktok'],
            domains: ['youtube.com', 'instagram.com', 'tiktok.com', 'www.marca.com'],
          }),
        ],
      }),
    );
    expect(section?.titles).toEqual([
      'Bloqueo: YouTube, Instagram +2 · Estricto',
      'Bloqueo: YouTube +3 · Estricto',
    ]);
  });

  it('lists the other blocks and breaks as rows, at most two, then «y N más»', () => {
    const section = blockSection(
      snapshot({
        blocks: [
          ruleBlock({ endsAt: iso(NOW + 90 * MIN) }),
          ruleBlock({
            id: 'blk_r',
            serviceIds: ['reddit'],
            domains: ['reddit.com'],
            mode: 'normal',
            endsAt: iso(NOW + 30 * MIN),
          }),
          ruleBlock({
            id: 'blk_c',
            serviceIds: [],
            domains: ['www.marca.com'],
            mode: 'hardcore',
            endsAt: iso(NOW + 20 * MIN),
          }),
        ],
        allowances: [{ serviceId: 'netflix', endsAt: iso(NOW + 9 * MIN) }],
      }),
    );
    expect(section?.rows.map((r) => r.title)).toEqual(['Reddit · Normal', 'marca.com · Hardcore']);
    expect(section?.rows).toHaveLength(MAX_ROWS);
    expect(section?.more).toBe(1);
  });

  it('a punishment reads «Castigo: …» in red', () => {
    const section = blockSection(
      snapshot({
        blocks: [
          ruleBlock({ kind: 'punishment', mode: 'hardcore', reason: '3 strikes en «mates»' }),
        ],
        punishment: { endsAt: iso(NOW + 60 * MIN), level: 'distractions' },
      }),
    );
    expect(section).toMatchObject({
      title: 'Castigo: todas las distracciones',
      accent: 'red',
      reason: '3 strikes en «mates»',
    });
  });

  it('a whitelist block: «Bloqueo: solo lista blanca · Examen», never a capital after «:»', () => {
    const exam = ruleBlock({
      id: 'blk_exam',
      mode: 'exam',
      whitelistOnly: true,
      serviceIds: [],
      domains: [],
      endsAt: iso(NOW + 90 * MIN),
    });
    const section = blockSection(snapshot({ blocks: [exam, ruleBlock()] }));
    expect(section?.title).toBe('Bloqueo: solo lista blanca · Examen');
    expect(section?.titles).toEqual(['Bloqueo: solo lista blanca · Examen']);
    expect(section?.accent).toBe('red');
    // A row starts its own line: the capitalized form.
    const rows = blockSection(
      snapshot({ blocks: [ruleBlock({ endsAt: iso(NOW + 99 * MIN) }), exam] }),
    );
    expect(rows?.rows.map((r) => r.title)).toEqual(['Todo salvo la lista blanca · Examen']);
    for (const title of section?.titles ?? []) expect(title).not.toMatch(/: [A-ZÁÉÍÓÚÑ][a-z]/);
  });

  it('a whitelist punishment reads «Castigo: solo lista blanca»', () => {
    const section = blockSection(
      snapshot({
        blocks: [
          ruleBlock({
            kind: 'punishment',
            mode: 'hardcore',
            whitelistOnly: true,
            serviceIds: [],
            domains: [],
          }),
        ],
        punishment: { endsAt: iso(NOW + 60 * MIN), level: 'whitelist' },
      }),
    );
    expect(section?.title).toBe('Castigo: solo lista blanca');
  });

  it('shows running breaks when nothing is blocked', () => {
    const section = blockSection(
      snapshot({ blocks: [], allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 9 * MIN) }] }),
    );
    expect(section?.rows).toEqual([
      { key: 'allowance:youtube', title: 'Descanso: YouTube', endsAt: NOW + 9 * MIN },
    ]);
  });
});

describe('popupTimes', () => {
  const reddit = ruleBlock({
    id: 'blk_r',
    serviceIds: ['reddit'],
    domains: ['reddit.com'],
    mode: 'normal',
    endsAt: iso(NOW + 30 * MIN),
  });

  it('a running block: countdown, «hasta 17:42», rows in minutes, the next second', () => {
    const section = blockSection(snapshot({ blocks: [ruleBlock(), reddit] }));
    const now = NOW + 250;
    expect(popupTimes(section, now)).toEqual({
      until: formatUntil(NOW + 43 * MIN, now),
      countdownMs: 43 * MIN - 250,
      rowValues: ['quedan 30 min'],
      announce: { kind: 'counting', key: 'block:blk_youtube', remainingMs: 43 * MIN - 250 },
      // 42:59.750 left: the countdown reads 43:00 for 750 ms more.
      nextTickMs: 754,
    });
    expect(section?.key).toBe('block:blk_youtube');
  });

  it('an ended block the snapshot still lists: «Comprobando la hora…», no past «hasta»', () => {
    // The guardian's boot hold (or new rules not here yet): ended 30 s ago, still listed.
    const now = NOW + 43 * MIN + 30_000;
    const section = blockSection(snapshot({ blocks: [ruleBlock()] }));
    const times = popupTimes(section, now);
    expect(times).toEqual({
      until: CHECKING,
      countdownMs: null,
      rowValues: [],
      announce: { kind: 'checking', key: 'block:blk_youtube' },
      nextTickMs: null,
    });
    expect(times.until).not.toMatch(/hasta/);
    // Exactly at the end, too: never a 0:00 countdown.
    expect(popupTimes(section, NOW + 43 * MIN)).toMatchObject({
      until: CHECKING,
      countdownMs: null,
    });
  });

  it('an ended row reads «Comprobando la hora…», never «quedan 0 min»', () => {
    const section = blockSection(
      snapshot({
        blocks: [ruleBlock(), reddit],
        allowances: [{ serviceId: 'netflix', endsAt: iso(NOW + 5 * MIN) }],
      }),
    );
    const now = NOW + 31 * MIN;
    const times = popupTimes(section, now);
    expect(times.rowValues).toEqual([CHECKING, CHECKING]);
    for (const value of times.rowValues) expect(value).not.toMatch(/0 min/);
    // The primary still runs, so the ticker keeps going.
    expect(times.countdownMs).toBe(12 * MIN);
    expect(times.until).toBe(formatUntil(NOW + 43 * MIN, now));
  });

  it('rows alone tick on the minute (they only show minutes)', () => {
    const section = blockSection(
      snapshot({ blocks: [], allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 9 * MIN) }] }),
    );
    expect(popupTimes(section, NOW + 10_000)).toEqual({
      until: '',
      countdownMs: null,
      rowValues: ['quedan 9 min'],
      announce: { kind: 'ended' },
      nextTickMs: 50_004,
    });
  });

  it('the live region hears the end only when the block leaves the snapshot', () => {
    const held = popupTimes(blockSection(snapshot()), NOW + 44 * MIN);
    expect(held.announce).toEqual({ kind: 'checking', key: 'block:blk_youtube' });
    const gone = popupTimes(blockSection(snapshot({ blocks: [] })), NOW + 44 * MIN);
    expect(gone.announce).toEqual({ kind: 'ended' });
    expect(popupTimes(null, NOW).announce).toEqual({ kind: 'none' });
  });

  it('an unreadable end shows no time and stays silent', () => {
    const section = blockSection(snapshot({ blocks: [ruleBlock({ endsAt: 'nunca' })] }));
    expect(popupTimes(section, NOW)).toMatchObject({
      until: '',
      countdownMs: null,
      announce: { kind: 'none' },
      nextTickMs: null,
    });
  });
});
