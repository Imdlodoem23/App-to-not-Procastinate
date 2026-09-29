import { describe, expect, it } from 'vitest';
import {
  blockCovers,
  blockTargets,
  displayHost,
  latestCovering,
  modeAccent,
} from '../../src/pages/shared/blocks';
import { MIN, NOW, iso, ruleBlock } from './fixtures';

describe('blockTargets', () => {
  it('names services, then custom hosts, once each', () => {
    const block = ruleBlock({
      serviceIds: ['youtube'],
      domains: ['youtube.com', 'www.youtube.com', 'www.marca.com', 'marca.com'],
    });
    expect(blockTargets(block)).toBe('YouTube, marca.com');
    expect(blockTargets(block, 1)).toBe('YouTube +1');
  });

  it('a whitelist block blocks everything but the list', () => {
    const wl = ruleBlock({ whitelistOnly: true, serviceIds: [], domains: [] });
    // At the start of a row, capitalized; after «Bloqueo:», lowercase like the app.
    expect(blockTargets(wl)).toBe('Todo salvo la lista blanca');
    expect(blockTargets(wl, 2, 'inline')).toBe('solo lista blanca');
    expect(blockTargets(wl, 1, 'inline')).toBe('solo lista blanca');
  });

  it('drops a leading www. only', () => {
    expect(displayHost('www.marca.com')).toBe('marca.com');
    expect(displayHost('m.marca.com')).toBe('m.marca.com');
    expect(displayHost('www.')).toBe('www.');
  });
});

describe('covering blocks', () => {
  const yt = ruleBlock();
  const wl = ruleBlock({ id: 'blk_w', whitelistOnly: true, serviceIds: [], domains: [] });

  it('matches hosts with their subdomains, or the service', () => {
    expect(blockCovers(yt, { cause: 'domain', serviceId: null, host: 'music.youtube.com' })).toBe(
      true,
    );
    expect(blockCovers(yt, { cause: 'domain', serviceId: 'youtube', host: null })).toBe(true);
    expect(blockCovers(yt, { cause: 'domain', serviceId: null, host: 'notyoutube.com' })).toBe(
      false,
    );
    expect(blockCovers(wl, { cause: 'domain', serviceId: 'youtube', host: null })).toBe(false);
    expect(blockCovers(wl, { cause: 'whitelist', serviceId: null, host: 'example.org' })).toBe(
      true,
    );
    expect(blockCovers(yt, { cause: 'whitelist', serviceId: null, host: 'youtube.com' })).toBe(
      false,
    );
  });

  it('picks the one that ends last', () => {
    const later = ruleBlock({ id: 'blk_2', endsAt: iso(NOW + 99 * MIN) });
    expect(
      latestCovering([yt, later], { cause: 'domain', serviceId: 'youtube', host: null })?.id,
    ).toBe('blk_2');
    expect(latestCovering([], { cause: 'domain', serviceId: 'youtube', host: null })).toBeNull();
  });
});

describe('modeAccent', () => {
  it('Normal blue, Estricto orange, Hardcore, Examen and punishments red', () => {
    expect(modeAccent('normal')).toBe('blue');
    expect(modeAccent('strict')).toBe('orange');
    expect(modeAccent('hardcore')).toBe('red');
    expect(modeAccent('exam')).toBe('red');
    expect(modeAccent('normal', 'punishment')).toBe('red');
  });
});
