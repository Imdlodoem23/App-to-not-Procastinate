/**
 * Blocks as the pages name them (pure): «YouTube, Instagram», the mode's accent, and which
 * live block covers a site (for blocked.html when the background has no attempt info).
 */
import { findServiceByDomain, getService, isSameOrSubdomain } from '@centrate/shared/catalog';
import type { BlockMode, PunishmentLevel } from '@centrate/shared/domain';
import type { ExtRuleBlock } from '@centrate/shared/guardian-api';
import { PAGES } from '../i18n';
import { parseIso } from './format';

/** Mode accents (PROMPT §10): Normal blue, Estricto orange, Hardcore and Examen red. */
export type ModeAccent = 'blue' | 'orange' | 'red';

export function modeAccent(mode: BlockMode, kind?: ExtRuleBlock['kind']): ModeAccent {
  if (kind === 'punishment') return 'red';
  switch (mode) {
    case 'normal':
      return 'blue';
    case 'strict':
      return 'orange';
    default:
      return 'red';
  }
}

export function modeLabel(mode: BlockMode): string {
  return PAGES.common.modes[mode];
}

/** «Castigo: todas las distracciones». */
export function punishmentTitle(level: PunishmentLevel | null): string {
  return PAGES.popup.punishment(PAGES.common.punishmentLevels[level ?? 'distractions']);
}

/** A host without a leading `www.` («www.marca.com» → «marca.com»). */
export function displayHost(host: string): string {
  return host.startsWith('www.') && host.length > 4 ? host.slice(4) : host;
}

/**
 * Where the names go: `start` begins a line (a row: «Todo salvo la lista blanca · Examen»),
 * `inline` follows «Bloqueo:» (a header: «Bloqueo: solo lista blanca · Examen»).
 */
export type TargetsPosition = 'start' | 'inline';

/**
 * Display names of what a block covers: its catalog services, then custom hosts (resolved
 * hosts no listed service owns), each once.
 */
export function blockTargetNames(
  block: Pick<ExtRuleBlock, 'serviceIds' | 'domains' | 'whitelistOnly'>,
  position: TargetsPosition = 'start',
): string[] {
  if (block.whitelistOnly) {
    const t = PAGES.common.targets;
    return [position === 'inline' ? t.whitelistShort : t.whitelistOnly];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  const services = new Set(block.serviceIds);
  for (const id of block.serviceIds) add(getService(id)?.name ?? id);
  for (const host of block.domains) {
    const owner = findServiceByDomain(host)?.id;
    if (owner !== undefined && services.has(owner)) continue;
    add(displayHost(host));
  }
  return names;
}

/** «YouTube, Instagram», «YouTube, Instagram +2» (never clipped by CSS). */
export function blockTargets(
  block: Pick<ExtRuleBlock, 'serviceIds' | 'domains' | 'whitelistOnly'>,
  maxNames = 2,
  position: TargetsPosition = 'start',
): string {
  const t = PAGES.common.targets;
  const names = blockTargetNames(block, position);
  if (names.length <= maxNames) return names.join(t.separator);
  return `${names.slice(0, maxNames).join(t.separator)} ${t.more(names.length - maxNames)}`;
}

/** What blocked.html knows about the site it replaced. */
export interface BlockedSite {
  cause: 'domain' | 'whitelist';
  serviceId: string | null;
  host: string | null;
}

/** Whether `block` blocks `site` (a `domain` block listing it, or a whitelist block). */
export function blockCovers(block: ExtRuleBlock, site: BlockedSite): boolean {
  if (site.cause === 'whitelist') return block.whitelistOnly;
  if (block.whitelistOnly) return false;
  if (site.host !== null) {
    const host = site.host;
    if (block.domains.some((d) => isSameOrSubdomain(host, d))) return true;
  }
  return site.serviceId !== null && block.serviceIds.includes(site.serviceId);
}

/** The covering block that ends last (when access actually returns), or `null`. */
export function latestCovering(
  blocks: readonly ExtRuleBlock[],
  site: BlockedSite,
): ExtRuleBlock | null {
  let best: ExtRuleBlock | null = null;
  let bestEnd = -Infinity;
  for (const block of blocks) {
    if (!blockCovers(block, site)) continue;
    const end = parseIso(block.endsAt) ?? Infinity;
    if (best === null || end >= bestEnd) {
      best = block;
      bestEnd = end;
    }
  }
  return best;
}
