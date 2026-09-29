/*
 * Domains no block may list (docs/ARCHITECTURE.md §5.2 and §16.2 #33): a custom domain
 * equal to or under one of them is rejected with `protected_target` (see
 * `isProtectedDomain`). Blocking them would stop operating system updates, the system
 * clock and connectivity checks, the guardian's own time calibration, or the way Céntrate
 * and its extension install and update themselves. Each entry covers its subdomains.
 *
 * - Every hostname the guardian asks for the time (guardian/internal/clock
 *   `networkTimeSources`: www.google.com, www.cloudflare.com, www.apple.com) is covered
 *   together with its parents, because `expandDomainVariants` turns a custom `google.com`
 *   into `www.google.com` too. Keep this list in step when that list changes.
 * - Unlike `ALWAYS_ALLOWED_HOSTS`, these hosts are not added to whitelist mode: they only
 *   matter outside the browser.
 * - `localhost` is not a valid custom domain by itself (one label); it is listed so that
 *   names under it (`app.localhost`) are refused too.
 * - No catalog service may list a protected domain or a parent of one (a test checks it).
 *
 * The guardian embeds this list through `catalogSnapshot()`.
 */
export const PROTECTED_DOMAIN_DATA: readonly string[] = [
  // Windows: updates, time (time.windows.com) and the network connectivity check.
  'microsoft.com',
  'windows.com',
  'windowsupdate.com',
  'msftconnecttest.com',
  'msftncsi.com',
  // macOS: updates, time (time.apple.com), captive portal check and update downloads.
  'apple.com',
  'cdn-apple.com',
  // Linux: the NTP pool and the package archives of the main distributions.
  'pool.ntp.org',
  'ubuntu.com',
  'debian.org',
  'fedoraproject.org',
  // Guardian time calibration (with parents) and its DNS-over-HTTPS resolvers.
  'google.com',
  'cloudflare.com',
  'cloudflare-dns.com',
  'dns.google',
  // Céntrate: releases and updates, the website, and the Firefox extension store (the
  // Chrome and Edge stores live under google.com and microsoft.com).
  'github.com',
  'githubusercontent.com',
  'centrate.onrender.com',
  'mozilla.org',
  'mozilla.net',
  // Loopback: the guardian's own API.
  'localhost',
];
