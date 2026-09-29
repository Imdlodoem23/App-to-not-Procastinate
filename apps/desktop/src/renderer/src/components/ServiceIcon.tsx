/**
 * A catalog service's icon (PROMPT §10): its favicon when the catalog has one, else its
 * monogram. With `?neutral-service-icons` in the renderer's URL (main adds it when launched
 * with `--harness-neutral-service-icons`, as the marketing captures are) every service draws
 * its monogram, whatever favicon exists (§11 «Legal»). Every service icon goes through here, so
 * a favicon always carries `data-service-favicon`, which the marketing guard looks for.
 */
import {
  SERVICE_FAVICON_ATTR,
  neutralServiceIconsFrom,
  serviceIcon,
} from '@centrate/shared/service-icon';

/** Read once: the switch is part of the renderer's URL and never changes while it runs. */
export const NEUTRAL_SERVICE_ICONS =
  typeof window !== 'undefined' && neutralServiceIconsFrom(window.location.search);

export function ServiceIcon(props: {
  monogram: string;
  /** The catalog favicon (a `data:` URL or an asset path), when there is one. */
  favicon?: string | null;
  className: string;
}): React.JSX.Element {
  const icon = serviceIcon(props, NEUTRAL_SERVICE_ICONS);
  if (icon.kind === 'favicon') {
    const tag = { [SERVICE_FAVICON_ATTR]: '' };
    return <img className={props.className} src={icon.src} alt="" draggable={false} {...tag} />;
  }
  return <span className={props.className}>{icon.text}</span>;
}
