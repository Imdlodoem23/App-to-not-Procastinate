import { describe, expect, it } from 'vitest';
import type { CatalogPlatform } from '../src/catalog';
import {
  BROWSERS,
  MULTI_LABEL_SUFFIXES,
  PROTECTED_DOMAINS,
  SERVICES,
  STUDY_APP_WHITELIST,
  catalogSnapshot,
  expandDomainVariants,
  findBrowsersByProcessName,
  getBrowser,
  isMultiLabelPublicSuffix,
  isProtectedDomain,
  isProtectedProcessName,
  isSameOrSubdomain,
  isValidDomain,
  isValidProcessName,
  processNameKey,
} from '../src/catalog';
import { BROWSER_FAMILIES } from '../src/domain';
import { findAllowDistraction, isPublicSuffixLike } from '../src/guardian-api';

const PLATFORMS: readonly CatalogPlatform[] = ['win', 'mac', 'linux'];

/** Hostnames the guardian asks for the time (guardian/internal/clock/network.go). */
const CALIBRATION_HOSTS = ['www.google.com', 'www.cloudflare.com', 'www.apple.com'];

/** Every parent of a host that is still a valid domain, the host included. */
function selfAndParents(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

describe('BROWSERS', () => {
  it('have unique kebab-case ids, a name and a known family', () => {
    const ids = BROWSERS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const browser of BROWSERS) {
      expect(browser.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(browser.name.length).toBeGreaterThan(0);
      expect(['chromium', 'firefox', 'safari', 'other']).toContain(browser.family);
      expect(BROWSER_FAMILIES as readonly string[]).toContain(browser.extensionFamily);
    }
  });

  it('cover the browsers of the brief', () => {
    for (const id of [
      'chrome',
      'edge',
      'brave',
      'opera',
      'opera-gx',
      'vivaldi',
      'firefox',
      'safari',
      'arc',
      'chromium',
      'yandex',
    ]) {
      expect(getBrowser(id), id).toBeDefined();
    }
    expect(getBrowser('netscape')).toBeUndefined();
  });

  it('name each extension family after its browser where BrowserFamily has one', () => {
    for (const family of BROWSER_FAMILIES) {
      if (family === 'other') continue;
      expect(getBrowser(family)?.extensionFamily, family).toBe(family);
    }
    expect(getBrowser('safari')?.extensionFamily).toBe('other');
    expect(getBrowser('arc')?.extensionFamily).toBe('chrome');
    expect(getBrowser('opera-gx')?.extensionFamily).toBe('opera');
  });

  it('list valid, unprotected process names, unique per browser and platform', () => {
    for (const browser of BROWSERS) {
      const total = PLATFORMS.reduce((n, p) => n + browser.processes[p].length, 0);
      expect(total, browser.id).toBeGreaterThan(0);
      for (const platform of PLATFORMS) {
        const names = browser.processes[platform];
        const keys = names.map((n) => processNameKey(n, platform));
        expect(new Set(keys).size, `${browser.id} ${platform}`).toBe(keys.length);
        for (const name of names) {
          expect(isValidProcessName(name), name).toBe(true);
          expect(isProtectedProcessName(name), name).toBe(false);
          if (platform === 'win') expect(name.toLowerCase().endsWith('.exe'), name).toBe(true);
          else expect(name.toLowerCase().endsWith('.exe'), name).toBe(false);
        }
      }
    }
  });

  it('share a process name only between browsers of the same engine', () => {
    for (const platform of PLATFORMS) {
      for (const browser of BROWSERS) {
        for (const name of browser.processes[platform]) {
          const owners = findBrowsersByProcessName(name, platform);
          expect(owners, `${platform} ${name}`).toContain(browser);
          expect(new Set(owners.map((b) => b.family)).size, `${platform} ${name}`).toBe(1);
        }
      }
    }
  });

  it('never list a generic executable', () => {
    const all = BROWSERS.flatMap((b) => PLATFORMS.flatMap((p) => b.processes[p]));
    for (const generic of [
      'browser.exe',
      'launcher.exe',
      'Electron',
      'plugin-container',
      'msedgewebview2.exe',
      'Browser Helper',
      'com.apple.WebKit.Networking',
    ]) {
      expect(all, generic).not.toContain(generic);
    }
  });

  it('include every browser of the study whitelist except embedded web views', () => {
    const study = STUDY_APP_WHITELIST.find((a) => a.id === 'browsers');
    expect(study).toBeDefined();
    for (const platform of PLATFORMS) {
      for (const name of study?.processes[platform] ?? []) {
        if (name === 'msedgewebview2.exe') continue;
        const owners = findBrowsersByProcessName(name, platform);
        expect(owners.length, `${platform} ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('find browsers by process name with the platform case rules', () => {
    expect(findBrowsersByProcessName('CHROME.EXE', 'win').map((b) => b.id)).toEqual([
      'chrome',
      'chromium',
    ]);
    expect(findBrowsersByProcessName(' msedge.exe ', 'win').map((b) => b.id)).toEqual(['edge']);
    expect(findBrowsersByProcessName('opera.exe', 'win').map((b) => b.id)).toEqual([
      'opera',
      'opera-gx',
    ]);
    expect(findBrowsersByProcessName('google chrome helper', 'mac').map((b) => b.id)).toEqual([
      'chrome',
    ]);
    expect(findBrowsersByProcessName('firefox', 'linux').map((b) => b.id)).toEqual(['firefox']);
    expect(findBrowsersByProcessName('Firefox', 'linux')).toEqual([]);
    expect(findBrowsersByProcessName('chrome.exe', 'linux')).toEqual([]);
    expect(findBrowsersByProcessName('notepad.exe', 'win')).toEqual([]);
  });
});

describe('PROTECTED_DOMAINS', () => {
  it('are unique canonical domains (plus localhost), none under another', () => {
    expect(new Set(PROTECTED_DOMAINS).size).toBe(PROTECTED_DOMAINS.length);
    for (const domain of PROTECTED_DOMAINS) {
      if (domain === 'localhost') continue;
      expect(isValidDomain(domain), domain).toBe(true);
    }
    for (const a of PROTECTED_DOMAINS) {
      for (const b of PROTECTED_DOMAINS) {
        if (a !== b) expect(isSameOrSubdomain(a, b), `${a} under ${b}`).toBe(false);
      }
    }
    expect(PROTECTED_DOMAINS).toContain('localhost');
  });

  it('cover the OS update and time hosts and Céntrate itself (§17)', () => {
    for (const host of [
      'microsoft.com',
      'windowsupdate.com',
      'windows.com',
      'apple.com',
      'time.windows.com',
      'time.apple.com',
      'pool.ntp.org',
      '2.pool.ntp.org',
      'github.com',
      'objects.githubusercontent.com',
      'centrate.onrender.com',
      'app.localhost',
      'addons.mozilla.org',
      'chromewebstore.google.com',
      'microsoftedge.microsoft.com',
      'https://download.windowsupdate.com/c/msdownload',
    ]) {
      expect(isProtectedDomain(host), host).toBe(true);
    }
  });

  it('cover every calibration hostname together with its parents', () => {
    for (const host of CALIBRATION_HOSTS) {
      for (const name of selfAndParents(host)) {
        expect(isProtectedDomain(name), name).toBe(true);
      }
      // What a user could type to reach it through the www./apex expansion.
      for (const typed of selfAndParents(host)) {
        expect(
          expandDomainVariants(typed).some((d) => isProtectedDomain(d)),
          typed,
        ).toBe(true);
      }
    }
  });

  it('leave ordinary and look-alike hosts alone', () => {
    for (const host of [
      'youtube.com',
      'onrender.com',
      'other.onrender.com',
      'ntp.org',
      'notgoogle.com',
      'google.com.evil.example',
      'localhost',
      'not a domain',
      '',
    ]) {
      expect(isProtectedDomain(host), host).toBe(false);
    }
  });

  it('are never listed, nor any parent of them, by a catalog service', () => {
    for (const service of SERVICES) {
      for (const domain of service.domains) {
        for (const protectedDomain of PROTECTED_DOMAINS) {
          expect(
            isSameOrSubdomain(protectedDomain, domain),
            `${service.id}: ${domain} would block ${protectedDomain}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('MULTI_LABEL_SUFFIXES', () => {
  it('are unique two-label lowercase suffixes of a two-letter country code', () => {
    expect(new Set(MULTI_LABEL_SUFFIXES).size).toBe(MULTI_LABEL_SUFFIXES.length);
    for (const suffix of MULTI_LABEL_SUFFIXES) {
      expect(suffix).toMatch(/^[a-z]{2,6}\.[a-z]{2}$/);
      expect(isValidDomain(suffix), suffix).toBe(true);
    }
    for (const suffix of ['co.uk', 'com.es', 'gob.es', 'com.mx', 'com.br', 'com.au', 'co.jp']) {
      expect(MULTI_LABEL_SUFFIXES).toContain(suffix);
    }
  });

  it('decide the www. variant and the public-suffix check', () => {
    expect(expandDomainVariants('educacion.gob.es')).toEqual([
      'educacion.gob.es',
      'www.educacion.gob.es',
    ]);
    expect(expandDomainVariants('www.bbc.co.uk')).toEqual(['www.bbc.co.uk', 'bbc.co.uk']);
    expect(expandDomainVariants('news.bbc.co.uk')).toEqual(['news.bbc.co.uk']);
    for (const suffix of MULTI_LABEL_SUFFIXES) {
      expect(isMultiLabelPublicSuffix(suffix), suffix).toBe(true);
      expect(isPublicSuffixLike(suffix), suffix).toBe(true);
    }
    for (const domain of ['example.com', 'bbc.co.uk', 'uk', 'co.example', 'example.es']) {
      expect(isPublicSuffixLike(domain), domain).toBe(false);
    }
  });

  it('make findAllowDistraction refuse a public suffix as a whitelist entry', () => {
    expect(
      findAllowDistraction(
        { domains: ['wikipedia.org', 'gob.es'], processes: [] },
        { domains: 'allow.customDomains', processes: 'allow.customProcesses' },
      ),
    ).toEqual({
      path: 'allow.customDomains[1]',
      reason: 'public_suffix',
      serviceId: null,
      appId: null,
    });
    expect(
      findAllowDistraction(
        { domains: ['educacion.gob.es'], processes: [] },
        { domains: 'allow.customDomains', processes: 'allow.customProcesses' },
      ),
    ).toBeNull();
  });
});

describe('catalogSnapshot (browsers, protected domains, suffixes)', () => {
  it('carries the new lists as plain copies', () => {
    const snapshot = catalogSnapshot();
    expect(snapshot.browsers).toHaveLength(BROWSERS.length);
    expect(snapshot.browsers.find((b) => b.id === 'firefox')).toEqual({
      id: 'firefox',
      name: 'Firefox',
      family: 'firefox',
      extensionFamily: 'firefox',
      processes: {
        win: ['firefox.exe'],
        mac: ['firefox'],
        linux: ['firefox', 'firefox-bin', 'firefox-esr'],
      },
    });
    expect(snapshot.protectedDomains).toEqual([...PROTECTED_DOMAINS]);
    expect(snapshot.multiLabelSuffixes).toEqual([...MULTI_LABEL_SUFFIXES]);
    snapshot.browsers[0]?.processes.win.push('evil.exe');
    snapshot.protectedDomains.push('evil.example');
    expect(BROWSERS[0]?.processes.win).not.toContain('evil.exe');
    expect(catalogSnapshot().protectedDomains).not.toContain('evil.example');
  });
});
