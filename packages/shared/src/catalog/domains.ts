/**
 * Pure helpers for domains typed by users or stored in the catalog.
 *
 * Canonical form: lowercase ASCII (IDNs in punycode), no scheme, path, port or trailing
 * dot, at least two labels, letters-only (or `xn--`) top-level label. IP addresses are
 * rejected: the hosts file maps names, and blocking an IP needs a firewall.
 */

import { MULTI_LABEL_SUFFIXES } from './data/index';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_INPUT_LENGTH = 2048;

/** `MULTI_LABEL_SUFFIXES` as a set (see ./data/public-suffixes.ts). */
const MULTI_LABEL_SUFFIX_SET: ReadonlySet<string> = new Set(MULTI_LABEL_SUFFIXES);

/** True when `domain` is already in canonical form (see module comment). */
export function isValidDomain(domain: string): boolean {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] ?? '';
  if (!TLD_RE.test(tld)) return false;
  return labels.every((label) => LABEL_RE.test(label));
}

/**
 * Turns what a user types («https://M.YouTube.com/watch?v=1», «*.tiktok.com»,
 * «ñandú.es.») into a canonical domain, or `null` if it is not a usable domain.
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) return null;
  let host: string;
  try {
    // The WHATWG URL parser lowercases, strips user info, port, path, query and fragment,
    // decodes percent escapes and converts IDNs to punycode, in Node and in browsers.
    host = new URL(SCHEME_RE.test(text) ? text : `http://${text}`).hostname;
  } catch {
    return null;
  }
  // «*.example.com» and «.example.com» mean the site itself; drop one trailing dot.
  host = host.replace(/^(?:\*?\.)+/, '').replace(/\.$/, '');
  return isValidDomain(host) ? host : null;
}

/** True when `domain` equals `parent` or is one of its subdomains (canonical inputs). */
export function isSameOrSubdomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

function isApex(domain: string): boolean {
  if (!isValidDomain(domain)) return false;
  const labels = domain.split('.');
  if (labels.length === 2) return true;
  return labels.length === 3 && MULTI_LABEL_SUFFIX_SET.has(labels.slice(1).join('.'));
}

/**
 * True when `domain` (canonical) is exactly a two-label public suffix such as `co.uk` or
 * `com.br` (see `MULTI_LABEL_SUFFIXES`): a whitelist entry like that would allow every
 * site under it.
 */
export function isMultiLabelPublicSuffix(domain: string): boolean {
  return MULTI_LABEL_SUFFIX_SET.has(domain);
}

/**
 * The hosts to block for a custom domain. The hosts file has no wildcards, so an apex
 * domain also gets its `www.` host and a `www.` host gets its apex:
 * `example.com` → [`example.com`, `www.example.com`]; `www.example.com` →
 * [`www.example.com`, `example.com`]; `m.example.com` → [`m.example.com`].
 * Returns [] when the input is not a usable domain.
 */
export function expandDomainVariants(domain: string): string[] {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return [];
  if (normalized.startsWith('www.')) {
    const apex = normalized.slice(4);
    return isApex(apex) ? [normalized, apex] : [normalized];
  }
  return isApex(normalized) ? [normalized, `www.${normalized}`] : [normalized];
}

const MAX_PATTERN_CACHE = 64;
const patternCache = new Map<string, RegExp | null>();

/** Compiles a host pattern once; invalid or unanchored patterns become `null`. */
function compileHostPattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (typeof pattern === 'string' && pattern.startsWith('^') && pattern.endsWith('$')) {
    try {
      compiled = new RegExp(pattern, 'u');
    } catch {
      compiled = null;
    }
  }
  if (patternCache.size >= MAX_PATTERN_CACHE) patternCache.clear();
  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * True when the canonical `host` matches a whitelist host pattern (a regular expression
 * source anchored with `^…$`, see `StudySite.hostPatterns`). Invalid or unanchored
 * patterns match nothing.
 */
export function matchesHostPattern(host: string, pattern: string): boolean {
  if (typeof host !== 'string' || !isValidDomain(host)) return false;
  return compileHostPattern(pattern)?.test(host) ?? false;
}

/**
 * True when `domain` is allowed by `whitelist`. A whitelist entry allows itself and every
 * subdomain (`wikipedia.org` allows `es.m.wikipedia.org`); `hostPatterns` (anchored
 * regular expressions, see `StudySite.hostPatterns`) allow the hosts they match. Inputs
 * are normalized, so URLs work too; invalid entries and patterns are ignored.
 */
export function isDomainAllowedInWhitelist(
  domain: string,
  whitelist: Iterable<string>,
  hostPatterns: Iterable<string> = [],
): boolean {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return false;
  for (const entry of whitelist) {
    const allowed = isValidDomain(entry) ? entry : normalizeDomain(entry);
    if (allowed !== null && isSameOrSubdomain(normalized, allowed)) return true;
  }
  for (const pattern of hostPatterns) {
    if (matchesHostPattern(normalized, pattern)) return true;
  }
  return false;
}
