import { describe, expect, it } from 'vitest';
import { SEND_CHANNELS, type SendChannel } from '../../../src/shared/ipc';
import { harnessFixture, listHarnessFixtures } from '../../../src/shared/fixtures';
import {
  SEND_GUARDS,
  isBlockDraft,
  isDetailRequest,
  isDraftSeed,
  isLayoutReport,
} from '../../../src/main/windows/send-guards';
import { PHASE5_VALID_SEND } from '../../shared/phase5-payloads';

const VALID: { [C in SendChannel]: unknown } = {
  'window:layout': { height: 512, density: 'regular', scroll: false },
  'window:show-ack': { seq: 3, layout: { height: 480.5, density: 'compact', scroll: false } },
  'window:ready': { stateId: 'idle', rev: 100 },
  'window:hide': null,
  'window:open-detail': { name: 'ajustes', group: 'sistema' },
  'window:close-detail': null,
  'window:confirm-draft': { draft: harnessFixture('confirm-normal').main.card?.draft },
  'block:create-dismiss': { intentId: 'intent-fixture-0001' },
  'app:open-guide': { guide: 'extension-chromium' },
  'app:quit': null,
  'app:renderer-error': { message: 'boom', stack: null },
  ...PHASE5_VALID_SEND,
};

describe('send guards', () => {
  it('cover every send channel and accept a valid payload', () => {
    for (const channel of SEND_CHANNELS) {
      expect(SEND_GUARDS[channel](VALID[channel]), channel).toBe(true);
    }
  });

  it('refuse extra keys, wrong types and undefined', () => {
    for (const channel of SEND_CHANNELS) {
      expect(SEND_GUARDS[channel](undefined), channel).toBe(false);
    }
    expect(isLayoutReport({ height: 500, density: 'regular', scroll: false, x: 1 })).toBe(false);
    expect(isLayoutReport({ height: -1, density: 'regular', scroll: false })).toBe(false);
    expect(isLayoutReport({ height: Infinity, density: 'regular', scroll: false })).toBe(false);
    expect(isLayoutReport({ height: 500, density: 'huge', scroll: false })).toBe(false);
    expect(SEND_GUARDS['window:hide']({})).toBe(false);
    expect(SEND_GUARDS['app:open-guide']({ guide: 'https://evil.example' })).toBe(false);
    expect(SEND_GUARDS['block:create-dismiss']({ intentId: 'has spaces' })).toBe(false);
    expect(SEND_GUARDS['window:show-ack']({ seq: -1, layout: VALID['window:layout'] })).toBe(false);
  });

  it('accept every detail request and draft the fixtures use', () => {
    for (const f of listHarnessFixtures()) {
      if (f.detailRequest) expect(isDetailRequest(f.detailRequest), f.id).toBe(true);
      if (f.main.card) expect(isBlockDraft(f.main.card.draft), f.id).toBe(true);
      expect(isBlockDraft(f.detail.bloqueos.form), f.id).toBe(true);
      if (f.detailRequest?.name === 'bloqueos' && f.detailRequest.seed) {
        expect(isDraftSeed(f.detailRequest.seed), f.id).toBe(true);
      }
    }
  });

  it('refuse malformed detail requests', () => {
    expect(isDetailRequest({ name: 'nuclear', group: null })).toBe(false);
    expect(isDetailRequest({ name: 'ajustes', group: 'hacks' })).toBe(false);
    expect(isDetailRequest({ name: 'bloqueos', seed: null, focus: 'everything' })).toBe(false);
    expect(isDetailRequest({ name: 'emergencia', blockIds: ['not-a-block'] })).toBe(false);
    expect(isDetailRequest({ name: 'emergencia', blockIds: null, extra: 1 })).toBe(false);
  });

  it('refuse drafts with a bad mode, end or target list', () => {
    const draft = harnessFixture('confirm-normal').main.card?.draft;
    expect(draft).toBeTruthy();
    expect(isBlockDraft({ ...draft, mode: 'nuclear' })).toBe(false);
    expect(isBlockDraft({ ...draft, end: { kind: 'until', endsAt: 'tomorrow' } })).toBe(false);
    expect(isBlockDraft({ ...draft, targets: { serviceIds: [1] } })).toBe(false);
    expect(isBlockDraft({ ...draft, reason: 'x'.repeat(1000) })).toBe(false);
  });
});
