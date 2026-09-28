import { describe, expect, it } from 'vitest';
import { SERVICES } from '../src/catalog';
import {
  NEUTRAL_SERVICE_ICONS_PARAM,
  catalogFavicon,
  neutralServiceIconsFrom,
  serviceIcon,
} from '../src/service-icon';

const FAVICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';

describe('neutral service icons (PROMPT §11 «Legal»)', () => {
  it('reads the switch from a query string', () => {
    expect(neutralServiceIconsFrom('')).toBe(false);
    expect(neutralServiceIconsFrom('?window=main&state=idle')).toBe(false);
    expect(neutralServiceIconsFrom(`?${NEUTRAL_SERVICE_ICONS_PARAM}`)).toBe(true);
    expect(neutralServiceIconsFrom(`?window=main&${NEUTRAL_SERVICE_ICONS_PARAM}=1`)).toBe(true);
    expect(neutralServiceIconsFrom(`?${NEUTRAL_SERVICE_ICONS_PARAM}=0`)).toBe(false);
    expect(neutralServiceIconsFrom(`?${NEUTRAL_SERVICE_ICONS_PARAM}=false`)).toBe(false);
  });

  it('draws the monogram whatever favicon exists when the switch is on', () => {
    const service = { monogram: 'YT', favicon: FAVICON };
    expect(serviceIcon(service, true)).toEqual({ kind: 'monogram', text: 'YT' });
    expect(serviceIcon(service, false)).toEqual({ kind: 'favicon', src: FAVICON });
    expect(serviceIcon({ monogram: 'YT' }, false)).toEqual({ kind: 'monogram', text: 'YT' });
    expect(serviceIcon({ monogram: 'YT', favicon: ' ' }, false)).toEqual({
      kind: 'monogram',
      text: 'YT',
    });
  });

  it('reads a catalog favicon only from a non-empty string', () => {
    expect(catalogFavicon({ favicon: FAVICON })).toBe(FAVICON);
    expect(catalogFavicon({ favicon: 42 })).toBeNull();
    expect(catalogFavicon({})).toBeNull();
    // Every catalog service can be drawn (its monogram, at worst).
    for (const service of SERVICES) {
      expect(serviceIcon(service, true)).toEqual({ kind: 'monogram', text: service.monogram });
    }
  });
});
