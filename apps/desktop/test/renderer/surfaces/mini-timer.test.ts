import { describe, expect, it } from 'vitest';
import type { StudySession } from '@centrate/shared/domain';
import { resolveFeatures } from '../../../src/shared/features';
import {
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  harnessFixture,
  makeBlock,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import { blockIcon, deriveMiniTimerView } from '../../../src/renderer/src/windows/mini-timer/view';

const now = HARNESS_NOW;

function snapshotOf(id: HarnessStateId): UiSnapshot {
  return harnessFixture(id).snapshot;
}

function withStudy(base: UiSnapshot, study: Partial<StudySession> | null): UiSnapshot {
  if (!base.state) throw new Error('fixture without state');
  const session = study ? ({ ...({} as StudySession), ...study } as StudySession) : null;
  return { ...base, state: { ...base.state, study: session } };
}

describe('mini timer', () => {
  it('counts down the fixture block with its first service icon', () => {
    const s = snapshotOf('mini-timer');
    const view = deriveMiniTimerView(s, now);
    expect(view).toEqual({
      kind: 'block',
      icon: { kind: 'service', serviceId: 'youtube', monogram: 'YT', favicon: null },
      label: 'Bloqueo: YouTube, Instagram · Estricto',
      endsAt: s.state?.blocks[0]?.endsAt,
      text: null,
      textTone: null,
      camera: false,
    });
  });

  it('reads the same in English', () => {
    const view = withLocale('en', () => deriveMiniTimerView(snapshotOf('mini-timer'), now));
    expect(view.label).toBe('Block: YouTube, Instagram · Strict');
  });

  it('counts down the latest block when there are several (the big countdown of section 2)', () => {
    const s = snapshotOf('three-blocks');
    expect(deriveMiniTimerView(s, now).endsAt).toBe(s.state?.blocks[0]?.endsAt);
  });

  it('shows a punishment with the shield and its level', () => {
    const s = snapshotOf('punishment');
    const view = deriveMiniTimerView(s, now);
    expect(view.kind).toBe('punishment');
    expect(view.icon).toEqual({ kind: 'glyph', glyph: 'punishment' });
    expect(view.label).toBe('Castigo: todas las distracciones');
    expect(view.endsAt).toBe(s.state?.blocks[0]?.endsAt);
    expect(deriveMiniTimerView(snapshotOf('nuclear'), now).label).toBe(
      'Castigo: ordenador bloqueado',
    );
  });

  it('says «Sin bloqueos» when nothing is blocked', () => {
    expect(deriveMiniTimerView(snapshotOf('idle'), now)).toMatchObject({
      kind: 'idle',
      icon: { kind: 'glyph', glyph: 'idle' },
      endsAt: null,
      text: 'Sin bloqueos',
      textTone: 'muted',
    });
  });

  it('never counts down blocks nobody enforces: «Guardián detenido», «Sin guardián»', () => {
    expect(deriveMiniTimerView(snapshotOf('protection-broken'), now)).toMatchObject({
      kind: 'down',
      endsAt: null,
      text: 'Guardián detenido',
      textTone: 'red',
    });
    expect(deriveMiniTimerView(snapshotOf('not-installed'), now)).toMatchObject({
      kind: 'down',
      text: 'Sin guardián',
    });
  });

  it('says «Comprobando…» during the boot hold, and «Conectando…» before the first state', () => {
    expect(deriveMiniTimerView(snapshotOf('boot-hold'), now)).toMatchObject({
      kind: 'checking',
      endsAt: null,
      text: 'Comprobando…',
    });
    const idle = snapshotOf('idle');
    const connecting: UiSnapshot = {
      ...idle,
      link: { ...idle.link, status: 'connecting' },
      state: null,
    };
    expect(deriveMiniTimerView(connecting, now)).toMatchObject({
      kind: 'connecting',
      text: 'Conectando…',
    });
  });

  it('draws a glyph when the block names no catalog service', () => {
    const categories = makeBlock(
      { n: 1, categories: ['social'], mode: 'normal', leftMs: 60_000, elapsedMs: 0 },
      now,
    );
    expect(blockIcon(categories)).toEqual({ kind: 'glyph', glyph: 'lock' });
    const exam = makeBlock({ n: 2, mode: 'exam', leftMs: 60_000, elapsedMs: 0 }, now);
    expect(blockIcon(exam)).toEqual({ kind: 'glyph', glyph: 'exam' });
    const unknown = makeBlock(
      { n: 3, services: ['not-a-service', 'tiktok'], mode: 'normal', leftMs: 1, elapsedMs: 0 },
      now,
    );
    expect(blockIcon(unknown)).toMatchObject({ kind: 'service', serviceId: 'tiktok' });
  });

  it('shows the camera dot only with Study Mode on and a session with the camera', () => {
    const base = snapshotOf('mini-timer');
    const camera = withStudy(base, { camera: true, status: 'active' });
    expect(deriveMiniTimerView(camera, now).camera).toBe(false); // the study flag is off
    const study = { ...camera, features: resolveFeatures({ study: true }) };
    expect(deriveMiniTimerView(study, now).camera).toBe(true);
    const noCamera = withStudy(study, { camera: false, status: 'active' });
    expect(deriveMiniTimerView(noCamera, now).camera).toBe(false);
    const ended = withStudy(study, { camera: true, status: 'completed' });
    expect(deriveMiniTimerView(ended, now).camera).toBe(false);
  });

  it('never leaves the time or the text empty for any fixture', () => {
    for (const id of HARNESS_STATE_IDS) {
      const view = deriveMiniTimerView(snapshotOf(id), now);
      expect(view.endsAt !== null || (view.text ?? '') !== '', id).toBe(true);
      if (view.endsAt) expect(view.label, id).toBeTruthy();
    }
  });
});
