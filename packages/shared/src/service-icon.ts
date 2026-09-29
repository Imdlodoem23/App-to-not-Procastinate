/**
 * How a catalog service is drawn next to its name (PROMPT.md §10: «su favicon guardado en el
 * catálogo») and the neutral mode of marketing captures (§11 «Legal»: «En las capturas de
 * marketing, cambia los favicons de los servicios por iconos neutros»).
 *
 * Every surface that draws a service icon goes through `serviceIcon`: with the neutral switch
 * on, it gives the catalog monogram whatever favicon the service has. A favicon, when one is
 * drawn, carries `SERVICE_FAVICON_ATTR`, so the marketing guard (scripts/marketing/lib/recorder.ts)
 * can prove there is none on screen.
 *
 * The switch is `?neutral-service-icons` in the page's query string: the desktop app adds it to
 * every renderer when launched with `--harness-neutral-service-icons` (harness only), and a
 * page reads it with `neutralServiceIconsFrom(location.search)`. A page that honours it marks
 * its `<html>` with `NEUTRAL_SERVICE_ICONS_ATTR`.
 */

export const NEUTRAL_SERVICE_ICONS_PARAM = 'neutral-service-icons';
/** On `<html>`: the page runs with the switch on. */
export const NEUTRAL_SERVICE_ICONS_ATTR = 'data-neutral-service-icons';
/** On every element that draws a service favicon (`<img>`, `<image>`, a background…). */
export const SERVICE_FAVICON_ATTR = 'data-service-favicon';

export type ServiceIcon = { kind: 'monogram'; text: string } | { kind: 'favicon'; src: string };

/** Whether a page's query string (`location.search`) turns the switch on. */
export function neutralServiceIconsFrom(search: string): boolean {
  const value = new URLSearchParams(search).get(NEUTRAL_SERVICE_ICONS_PARAM);
  return value !== null && value !== '0' && value !== 'false';
}

/**
 * The favicon a catalog entry carries (`favicon`: a `data:` URL or an asset path), or `null`.
 * The catalog has none yet; this is the one place that reads the field.
 */
export function catalogFavicon(entry: object): string | null {
  const favicon = 'favicon' in entry ? entry.favicon : undefined;
  return typeof favicon === 'string' && favicon.trim() !== '' ? favicon : null;
}

/** The icon to draw: the favicon when there is one and the switch is off, else the monogram. */
export function serviceIcon(
  service: { monogram: string; favicon?: string | null },
  neutral: boolean,
): ServiceIcon {
  const favicon = neutral ? null : catalogFavicon(service);
  return favicon ? { kind: 'favicon', src: favicon } : { kind: 'monogram', text: service.monogram };
}
