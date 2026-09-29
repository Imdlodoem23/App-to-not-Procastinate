import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_ALLOWED_HOSTS,
  APPS,
  CATEGORIES,
  CATEGORY_IDS,
  PROTECTED_PROCESS_NAMES,
  SERVICES,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
  allDistractionTargets,
  findAliasConflicts,
  findServiceByDomain,
  findServiceByWindowTitle,
  getService,
  isAllowedInStudyWhitelist,
  isDomainAllowedInWhitelist,
  isProtectedProcessName,
  isSameOrSubdomain,
  isValidDomain,
  isValidProcessName,
  listAliases,
  normalizeAlias,
  processNameKey,
  resolveTargets,
  studyWhitelistDomains,
  studyWhitelistHostPatterns,
} from '../src/catalog';
import type { CatalogPlatform } from '../src/catalog';

const PLATFORMS: readonly CatalogPlatform[] = ['win', 'mac', 'linux'];

/**
 * Subdomain overlaps between services that are intended. Prime Video's API hosts live
 * under amazon.com; exact hosts are still unique.
 */
const INTENDED_OVERLAPS: ReadonlyArray<readonly [child: string, parent: string]> = [
  ['prime-video', 'amazon'],
];

/** Shared infrastructure that must never be blocked as a whole. */
const SHARED_INFRASTRUCTURE = [
  'google.com',
  'www.google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'googlevideo.com',
  'ggpht.com',
  'akamaihd.net',
  'akamaized.net',
  'akamai.net',
  'cloudfront.net',
  'cloudflare.com',
  'fastly.net',
  'azureedge.net',
  'amazonaws.com',
  'fbcdn.net',
  'facebook.net',
  'alicdn.com',
  'microsoft.com',
  'live.com',
  'apple.com',
  'icloud.com',
  'github.com',
  'go.com',
  'xbox.com',
  'xboxlive.com',
];

describe('categories', () => {
  it('has the six categories with their Spanish names', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual([...CATEGORY_IDS]);
    expect(Object.fromEntries(CATEGORIES.map((c) => [c.id, c.name]))).toEqual({
      social: 'Redes sociales',
      video: 'Vídeo y streaming',
      games: 'Juegos',
      messaging: 'Mensajería',
      shopping: 'Compras',
      news: 'Noticias y deportes',
    });
  });

  it('every category has services', () => {
    for (const category of CATEGORIES) {
      expect(
        SERVICES.some((s) => s.categories.includes(category.id)),
        category.id,
      ).toBe(true);
    }
  });
});

describe('services', () => {
  it('have unique kebab-case ASCII ids', () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('have a name, a 1-2 character monogram and known categories', () => {
    for (const service of SERVICES) {
      expect(service.name.trim().length, service.id).toBeGreaterThan(0);
      expect([...service.monogram].length, service.id).toBeGreaterThanOrEqual(1);
      expect([...service.monogram].length, service.id).toBeLessThanOrEqual(2);
      for (const category of service.categories) expect(CATEGORY_IDS).toContain(category);
      expect(new Set(service.categories).size).toBe(service.categories.length);
    }
  });

  it('every service has at least one domain, all valid and unique within the service', () => {
    for (const service of SERVICES) {
      expect(service.domains.length, service.id).toBeGreaterThan(0);
      for (const domain of service.domains) {
        expect(isValidDomain(domain), `${service.id}: ${domain}`).toBe(true);
      }
      expect(new Set(service.domains).size, service.id).toBe(service.domains.length);
    }
  });

  it('no domain belongs to two services', () => {
    const owners = new Map<string, string>();
    const duplicates: string[] = [];
    for (const service of SERVICES) {
      for (const domain of service.domains) {
        const owner = owners.get(domain);
        if (owner) duplicates.push(`${domain}: ${owner} + ${service.id}`);
        owners.set(domain, service.id);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('only intended services have hosts under another service domain', () => {
    const overlaps = new Set<string>();
    for (const child of SERVICES) {
      for (const parent of SERVICES) {
        if (child.id === parent.id) continue;
        const nested = child.domains.some((d) =>
          parent.domains.some((p) => d !== p && isSameOrSubdomain(d, p)),
        );
        if (nested) overlaps.add(`${child.id}<${parent.id}`);
      }
    }
    expect([...overlaps].sort()).toEqual(INTENDED_OVERLAPS.map(([c, p]) => `${c}<${p}`).sort());
  });

  it('never block shared infrastructure as a whole', () => {
    const all = SERVICES.flatMap((s) => s.domains);
    for (const domain of SHARED_INFRASTRUCTURE) expect(all, domain).not.toContain(domain);
  });

  it('include every service named in the brief, in the right category', () => {
    const expected: Record<string, string[]> = {
      social: [
        'tiktok',
        'instagram',
        'x-twitter',
        'facebook',
        'snapchat',
        'reddit',
        'pinterest',
        'bereal',
        'threads',
        'tumblr',
        'bluesky',
      ],
      video: [
        'youtube',
        'twitch',
        'kick',
        'netflix',
        'disney-plus',
        'prime-video',
        'hbo-max',
        'movistar-plus',
        'crunchyroll',
        'filmin',
        'atresplayer',
      ],
      games: [
        'poki',
        'crazygames',
        'miniclip',
        'friv',
        'y8',
        'kongregate',
        'roblox',
        'steam',
        'epic-games',
        'minecraft',
        'fortnite',
        'league-of-legends',
        'valorant',
        'battle-net',
        'riot-client',
      ],
      messaging: ['discord', 'whatsapp', 'telegram'],
      shopping: ['amazon', 'aliexpress', 'shein', 'temu', 'zalando', 'ebay', 'wallapop', 'vinted'],
      news: [
        'marca',
        'as',
        'mundo-deportivo',
        'sport',
        'espn',
        'el-pais',
        '20minutos',
        'el-mundo',
        'xataka',
      ],
    };
    for (const [category, ids] of Object.entries(expected)) {
      for (const id of ids) expect(getService(id)?.categories, id).toContain(category);
    }
  });

  it('YouTube starts with exactly the eight domains from the brief', () => {
    const youtube = getService('youtube');
    expect(youtube?.domains).toEqual(
      expect.arrayContaining([
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
        'youtube-nocookie.com',
        'www.youtube-nocookie.com',
        'youtubei.googleapis.com',
      ]),
    );
    expect(youtube?.domains.slice(0, 8)).toEqual([
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'www.youtube-nocookie.com',
      'youtubei.googleapis.com',
    ]);
    expect(youtube?.educationalCapable).toBe(true);
  });

  it('HBO Max covers both max.com and hbomax.com', () => {
    expect(getService('hbo-max')?.domains).toEqual(
      expect.arrayContaining(['max.com', 'www.max.com', 'hbomax.com', 'www.hbomax.com']),
    );
  });

  it('blocks cloud gaming and web game portals with the games', () => {
    for (const id of ['geforce-now', 'xbox-cloud-gaming', 'now-gg', 'boosteroid', '1001juegos']) {
      expect(getService(id)?.categories, id).toEqual(['games']);
    }
    const games = resolveTargets({ categoryIds: ['games'] }, 'win').domains;
    for (const host of [
      'play.geforcenow.com',
      'www.xbox.com',
      'now.gg',
      'cloud.boosteroid.com',
      'www.1001juegos.com',
      'www.easports.com',
    ]) {
      expect(games, host).toContain(host);
    }
    expect(resolveTargets({ categoryIds: ['games'] }, 'win').processes).toEqual(
      expect.arrayContaining(['GeForceNOW.exe', 'FC25.exe', 'FC26.exe', 'GTA5_Enhanced.exe']),
    );
  });

  it('includes the live-score sites in news', () => {
    for (const id of ['flashscore', 'sofascore', 'besoccer']) {
      expect(getService(id)?.categories, id).toEqual(['news']);
    }
  });

  it('lists the Telegram Web socket hosts the hosts file must cut off', () => {
    const domains = getService('telegram')?.domains ?? [];
    for (const prefix of ['kws', 'zws']) {
      for (let i = 1; i <= 5; i += 1) {
        expect(domains).toContain(`${prefix}${i}.web.telegram.org`);
        expect(domains).toContain(`${prefix}${i}-1.web.telegram.org`);
      }
    }
    for (const dc of ['pluto', 'venus', 'aurora', 'vesta', 'flora']) {
      expect(domains).toContain(`${dc}.web.telegram.org`);
      expect(domains).toContain(`${dc}-1.web.telegram.org`);
    }
    expect(domains).toEqual(
      expect.arrayContaining(['webk.telegram.org', 'webz.telegram.org', 'weba.telegram.org']),
    );
  });

  it('lists the alternate hosts that serve the full Facebook and Pinterest apps', () => {
    expect(getService('facebook')?.domains).toEqual(
      expect.arrayContaining([
        'es-es.facebook.com',
        'es-la.facebook.com',
        'd.facebook.com',
        'x.facebook.com',
        'free.facebook.com',
      ]),
    );
    expect(getService('pinterest')?.domains).toEqual(
      expect.arrayContaining([
        'mx.pinterest.com',
        'ar.pinterest.com',
        'co.pinterest.com',
        'cl.pinterest.com',
        'pe.pinterest.com',
        'uk.pinterest.com',
        'pinterest.com.mx',
        'www.pinterest.co.uk',
      ]),
    );
  });

  it('keeps learning-friendly services opt-in (no category)', () => {
    for (const id of ['linkedin', 'vimeo', 'chess-com', 'lichess', 'spotify', 'rtve-play']) {
      expect(getService(id)?.categories, id).toEqual([]);
    }
    const blocked = new Set(PLATFORMS.flatMap((p) => allDistractionTargets(p).domains));
    for (const domain of ['linkedin.com', 'vimeo.com', 'chess.com', 'open.spotify.com']) {
      expect(blocked.has(domain), domain).toBe(false);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(ALWAYS_ALLOWED_HOSTS)).toBe(true);
    expect(Object.isFrozen(SERVICES)).toBe(true);
    expect(Object.isFrozen(SERVICES[0])).toBe(true);
    expect(Object.isFrozen(SERVICES[0]?.domains)).toBe(true);
    expect(Object.isFrozen(APPS[0]?.processes.win)).toBe(true);
  });
});

describe('excluded subdomains', () => {
  const withExclusions = SERVICES.filter((s) => (s.excludedSubdomains ?? []).length > 0);
  const allDomains = SERVICES.flatMap((s) => s.domains);

  it('are valid strict subdomains of the service and never blocked hosts', () => {
    for (const service of withExclusions) {
      const hosts = service.excludedSubdomains ?? [];
      expect(new Set(hosts).size, service.id).toBe(hosts.length);
      for (const host of hosts) {
        expect(isValidDomain(host), host).toBe(true);
        expect(
          service.domains.some((d) => d !== host && isSameOrSubdomain(host, d)),
          `${host} under ${service.id}`,
        ).toBe(true);
        // No catalog host is the excluded host or sits under it.
        for (const domain of allDomains) {
          expect(isSameOrSubdomain(domain, host), `${domain} under ${host}`).toBe(false);
        }
      }
    }
  });

  it('keep learning and sign-in hosts reachable (regression)', () => {
    const excluded = new Map(
      withExclusions.flatMap((s) => (s.excludedSubdomains ?? []).map((h) => [h, s.id] as const)),
    );
    expect(Object.fromEntries(excluded)).toMatchObject({
      'aws.amazon.com': 'amazon',
      'read.amazon.com': 'amazon',
      'leer.amazon.es': 'amazon',
      'dev.epicgames.com': 'epic-games',
      'www.epicgames.com': 'epic-games',
      'education.minecraft.net': 'minecraft',
      'create.roblox.com': 'roblox',
    });
    // The hosts file never lists the Epic login.
    expect(allDomains).not.toContain('www.epicgames.com');
  });
});

describe('always-allowed hosts', () => {
  it('are valid, never listed by a service and never blocked', () => {
    const allDomains = new Set(SERVICES.flatMap((s) => s.domains));
    for (const host of ALWAYS_ALLOWED_HOSTS) {
      expect(isValidDomain(host), host).toBe(true);
      expect(allDomains.has(host), host).toBe(false);
      expect(findServiceByDomain(host), host).toBeUndefined();
      expect(isAllowedInStudyWhitelist(host), host).toBe(true);
    }
    for (const platform of PLATFORMS) {
      const blocked = allDistractionTargets(platform);
      for (const host of ALWAYS_ALLOWED_HOSTS) {
        expect(blocked.domains).not.toContain(host);
        expect(blocked.excludedDomains).toContain(host);
      }
    }
  });

  it('keep the Google sign-in step accounts.youtube.com out of YouTube (regression)', () => {
    expect(ALWAYS_ALLOWED_HOSTS).toContain('accounts.youtube.com');
    expect(getService('youtube')?.domains).not.toContain('accounts.youtube.com');
  });
});

describe('apps', () => {
  it('have unique ids and at least one process on some platform', () => {
    const ids = APPS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const app of APPS) {
      expect(
        PLATFORMS.some((p) => app.processes[p].length > 0),
        app.id,
      ).toBe(true);
    }
  });

  it('use valid, unprotected process names without duplicates per platform', () => {
    for (const app of [...APPS, ...STUDY_APP_WHITELIST]) {
      for (const platform of PLATFORMS) {
        const names = app.processes[platform];
        for (const name of names) {
          expect(isValidProcessName(name), `${app.id}: ${name}`).toBe(true);
          if (APPS.includes(app)) {
            expect(isProtectedProcessName(name), `${app.id}: ${name}`).toBe(false);
          }
        }
        const keys = names.map((n) => processNameKey(n, platform));
        expect(new Set(keys).size, `${app.id}/${platform}`).toBe(keys.length);
      }
    }
  });

  it('Windows names end in .exe and are never generic hosts', () => {
    const generic = ['javaw.exe', 'java.exe', 'wwahost.exe', 'windows10universal.exe', 'launcher'];
    for (const app of APPS) {
      for (const name of app.processes.win) expect(name.toLowerCase(), app.id).toMatch(/\.exe$/);
      for (const platform of PLATFORMS) {
        for (const name of app.processes[platform]) {
          expect(generic, `${app.id}: ${name}`).not.toContain(name.toLowerCase());
        }
      }
    }
  });

  it('every app is referenced by a service or category, and every reference exists', () => {
    const referenced = new Set([
      ...SERVICES.flatMap((s) => s.appIds ?? []),
      ...CATEGORIES.flatMap((c) => c.appIds ?? []),
    ]);
    const appIds = new Set(APPS.map((a) => a.id));
    for (const id of referenced) expect(appIds.has(id), id).toBe(true);
    for (const id of appIds) expect(referenced.has(id), id).toBe(true);
  });

  it('includes the process names from the brief', () => {
    const win = new Set(APPS.flatMap((a) => a.processes.win));
    for (const name of [
      'Discord.exe',
      'steam.exe',
      'steamwebhelper.exe',
      'RobloxPlayerBeta.exe',
      'EpicGamesLauncher.exe',
      'MinecraftLauncher.exe',
      'FortniteClient-Win64-Shipping.exe',
      'LeagueClient.exe',
      'VALORANT.exe',
      'RiotClientServices.exe',
      'Battle.net.exe',
      'WhatsApp.exe',
      'WhatsApp.Root.exe',
      'Telegram.exe',
    ]) {
      expect(win.has(name), name).toBe(true);
    }
    const discord = APPS.find((a) => a.id === 'discord');
    expect(discord?.processes.mac).toContain('Discord');
    expect(discord?.processes.linux).toEqual(expect.arrayContaining(['Discord', 'discord']));
    const steam = APPS.find((a) => a.id === 'steam');
    expect(steam?.processes.mac).toEqual(expect.arrayContaining(['steam_osx', 'Steam Helper']));
    expect(steam?.processes.linux).toContain('steam');
    expect(APPS.find((a) => a.id === 'roblox')?.processes.mac).toEqual(['RobloxPlayer']);
  });

  it('never closes Roblox Studio and keeps its Creator Hub reachable', () => {
    // Studio's process is never targeted. Its sign-in and updates still share the
    // player's hosts, so they stop while Roblox is blocked (documented in games.ts).
    const all = APPS.flatMap((a) => PLATFORMS.flatMap((p) => a.processes[p]));
    expect(all.some((name) => /studio/i.test(name))).toBe(false);
    expect(getService('roblox')?.excludedSubdomains).toContain('create.roblox.com');
    expect(findServiceByDomain('create.roblox.com')).toBeUndefined();
  });

  it('targets the macOS Minecraft launcher by its bundle and newer game executables', () => {
    expect(APPS.find((a) => a.id === 'minecraft-launcher')?.processes.mac).toEqual(['Minecraft']);
    const win = new Set(APPS.flatMap((a) => a.processes.win));
    for (const name of ['GTA5_Enhanced.exe', 'FC25.exe', 'FC26.exe', 'GeForceNOW.exe']) {
      expect(win.has(name), name).toBe(true);
    }
  });

  it('only lists Windows names on Linux that fit in /proc/<pid>/comm (15 bytes)', () => {
    const encoder = new TextEncoder();
    for (const app of APPS) {
      for (const name of app.processes.linux) {
        if (!name.toLowerCase().endsWith('.exe')) continue;
        expect(encoder.encode(name).length, `${app.id}: ${name}`).toBeLessThanOrEqual(15);
      }
    }
    expect(APPS.find((a) => a.id === 'popular-pc-games')?.processes.linux).toEqual(
      expect.arrayContaining(['cs2', 'dota2', 'GTA5.exe', 'Overwatch.exe']),
    );
  });
});

describe('study whitelist', () => {
  it('has unique ids and valid domains', () => {
    const ids = STUDY_WHITELIST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const site of STUDY_WHITELIST) {
      expect(site.domains.length, site.id).toBeGreaterThan(0);
      for (const domain of site.domains) expect(isValidDomain(domain), domain).toBe(true);
    }
  });

  it('covers the tools named in the brief', () => {
    const domains = studyWhitelistDomains();
    for (const host of [
      'classroom.google.com',
      'moodle.org',
      'docs.google.com',
      'drive.google.com',
      'accounts.google.com',
      'www.office.com',
      'login.microsoftonline.com',
      'onedrive.live.com',
      'teams.microsoft.com',
      'es.wikipedia.org',
      'en.wikipedia.org',
      'es.khanacademy.org',
      'www.geogebra.org',
      'www.desmos.com',
      'www.wolframalpha.com',
      'dle.rae.es',
      'translate.google.com',
      'www.deepl.com',
      'www.wordreference.com',
    ]) {
      expect(isDomainAllowedInWhitelist(host, domains), host).toBe(true);
    }
  });

  it('never allows a distraction host, and no distraction host covers a study host', () => {
    const whitelist = studyWhitelistDomains();
    for (const service of SERVICES) {
      for (const domain of service.domains) {
        expect(isDomainAllowedInWhitelist(domain, whitelist), `${service.id}: ${domain}`).toBe(
          false,
        );
        expect(isAllowedInStudyWhitelist(domain), `${service.id}: ${domain}`).toBe(false);
        for (const allowed of whitelist) {
          expect(isSameOrSubdomain(allowed, domain), `${allowed} under ${domain}`).toBe(false);
        }
      }
    }
  });

  it('does not allow Google or Microsoft as a whole', () => {
    const whitelist = studyWhitelistDomains();
    for (const domain of ['google.com', 'googleapis.com', 'googleusercontent.com', 'live.com']) {
      expect(whitelist).not.toContain(domain);
    }
    expect(isDomainAllowedInWhitelist('news.google.com', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('play.google.com', whitelist)).toBe(false);
    for (const host of [
      'google.com',
      'www.google.com',
      'news.google.com',
      'googleusercontent.com',
      'yt3.googleusercontent.com',
      'lh3.googleusercontent.com.evil.com',
      'live.com',
      'outlook.live.com',
      'office.net',
      'msn.com',
    ]) {
      expect(isAllowedInStudyWhitelist(host), host).toBe(false);
    }
  });

  it('covers the hosts Google Workspace, Microsoft 365 and schools really use (regression)', () => {
    for (const host of [
      'doc-0s-8c-docs.googleusercontent.com',
      'doc-10-5k-docs.googleusercontent.com',
      'lh3.googleusercontent.com',
      'lh7-rt.googleusercontent.com',
      'lh3.google.com',
      'clients6.google.com',
      'res.cdn.office.net',
      'res-1.cdn.office.net',
      'statics.teams.cdn.office.net',
      'static2.sharepointonline.com',
      'aadcdn.msftauth.net',
      'logincdn.msftauth.net',
      'acctcdn.msauth.net',
      'account.live.com',
      '1drv.ms',
      'raices.madrid.org',
      'educacionadistancia.juntadeandalucia.es',
      'seneca.juntadeandalucia.es',
      'www.edu.xunta.gal',
      'educamosclm.castillalamancha.es',
      'aulavirtual.murciaeduca.es',
      'rayuela.educarex.es',
      'www.notion.com',
      'www.liveworksheets.com',
      'kahoot.it',
      'app.zoom.us',
      'accounts.youtube.com',
    ]) {
      expect(isAllowedInStudyWhitelist(host), host).toBe(true);
    }
  });

  it('host patterns are anchored, RE2-safe and never match distraction hosts', () => {
    const patterns = studyWhitelistHostPatterns();
    const allDomains = SERVICES.flatMap((s) => s.domains);
    for (const pattern of patterns) {
      expect(pattern.startsWith('^') && pattern.endsWith('$'), pattern).toBe(true);
      // No lookarounds or backreferences: declarativeNetRequest regexFilter uses RE2.
      expect(/\(\?[=!<]|\\\d/.test(pattern), pattern).toBe(false);
      const re = new RegExp(pattern, 'u');
      for (const domain of allDomains) expect(re.test(domain), `${pattern} ${domain}`).toBe(false);
    }
    for (const site of STUDY_WHITELIST) {
      for (const pattern of site.hostPatterns ?? []) {
        expect(typeof pattern).toBe('string');
      }
    }
  });

  it('includes the study apps from the brief', () => {
    const ids = STUDY_APP_WHITELIST.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'word',
      'excel',
      'powerpoint',
      'onenote',
      'notion',
      'obsidian',
      'acrobat',
      'libreoffice',
      'vscode',
      'browsers',
      'zoom',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('keeps the browsers on every platform and never lists a generic executable', () => {
    const browsers = STUDY_APP_WHITELIST.find((a) => a.id === 'browsers');
    for (const platform of PLATFORMS) {
      expect(browsers?.processes[platform].length, platform).toBeGreaterThan(0);
    }
    const all = STUDY_APP_WHITELIST.flatMap((a) => PLATFORMS.flatMap((p) => a.processes[p]));
    for (const generic of ['Electron', 'java', 'javaw.exe', 'launcher']) {
      expect(all, generic).not.toContain(generic);
    }
    expect(STUDY_APP_WHITELIST.find((a) => a.id === 'vscode')?.processes.mac).toContain(
      'Visual Studio Code',
    );
  });
});

describe('aliases', () => {
  it('are lowercase, trimmed and meaningful', () => {
    for (const item of [...SERVICES, ...CATEGORIES]) {
      for (const alias of item.aliases) {
        expect(alias, item.id).toBe(alias.toLowerCase());
        expect(alias, item.id).toBe(alias.trim());
        expect(normalizeAlias(alias).length, `${item.id}: ${alias}`).toBeGreaterThan(0);
      }
    }
  });

  it('are unique across services and categories', () => {
    expect(findAliasConflicts()).toEqual([]);
  });

  it('list ids, names and aliases for the parser', () => {
    const entries = listAliases();
    expect(entries).toContainEqual({ alias: 'youtube', kind: 'service', id: 'youtube' });
    expect(entries).toContainEqual({ alias: 'disney plus', kind: 'service', id: 'disney-plus' });
    expect(entries).toContainEqual({ alias: 'redes sociales', kind: 'category', id: 'social' });
    expect(entries).toContainEqual({ alias: 'video y streaming', kind: 'category', id: 'video' });
  });
});

describe('protected processes', () => {
  it('are unique and valid names', () => {
    const keys = PROTECTED_PROCESS_NAMES.map((n) => n.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of PROTECTED_PROCESS_NAMES) expect(isValidProcessName(name), name).toBe(true);
  });

  const GO_FILE = fileURLToPath(
    new URL('../../../guardian/internal/procwatch/protected.go', import.meta.url),
  );

  /**
   * Accessibility tools added here first; the guardian's protectedNames must add them
   * too. Remove each name from this list once protected.go has it.
   */
  const PENDING_IN_GUARDIAN: ReadonlySet<string> = new Set([
    'osk.exe',
    'TabTip.exe',
    'Narrator.exe',
    'Magnify.exe',
    'AtBroker.exe',
    'Utilman.exe',
    'nvda.exe',
    'jfw.exe',
    'VoiceOver',
    'AssistiveControl',
    'orca',
    'onboard',
  ]);

  /** The guardian's denyKey (guardian/internal/procwatch/fold.go). */
  const denyKey = (name: string): string =>
    name
      .trim()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/\.exe$/, '')
      .replace(/\.app$/, '')
      .trim();

  function goStrings(source: string, variable: string): string[] {
    const block = new RegExp(`var ${variable} = \\[\\]string\\{([\\s\\S]*?)\\n\\}`).exec(source);
    return [...(block?.[1] ?? '').matchAll(/"([^"\\]+)"/g)].map((m) => m[1] ?? '');
  }

  it.skipIf(!existsSync(GO_FILE))('match the guardian deny-list both ways', () => {
    const source = readFileSync(GO_FILE, 'utf8');
    const goNames = goStrings(source, 'protectedNames');
    const goPrefixes = goStrings(source, 'protectedPrefixes');
    expect(goNames.length).toBeGreaterThan(50);
    expect(goPrefixes).toEqual(['centrate', 'uninstall centrate']);

    // Everything the guardian protects is protected here.
    for (const name of goNames) expect(isProtectedProcessName(name), name).toBe(true);
    for (const prefix of goPrefixes) {
      expect(isProtectedProcessName(`${prefix} something new`), prefix).toBe(true);
    }

    // Everything protected here is protected by the guardian (except the pending names).
    const goKeys = new Set(goNames.map(denyKey));
    const goProtects = (name: string): boolean =>
      goKeys.has(denyKey(name)) || goPrefixes.some((p) => denyKey(name).startsWith(p));
    const missingInGo = PROTECTED_PROCESS_NAMES.filter((name) => !goProtects(name));
    expect(missingInGo.filter((name) => !PENDING_IN_GUARDIAN.has(name))).toEqual([]);
  });
});

describe('window title hints', () => {
  it('recognize desktop launchers and web app titles (regression)', () => {
    expect(findServiceByWindowTitle('WhatsApp Web')?.id).toBe('whatsapp');
    expect(findServiceByWindowTitle('Epic Games Launcher')?.id).toBe('epic-games');
    expect(findServiceByWindowTitle('Minecraft Launcher')?.id).toBe('minecraft');
  });

  it('are unique across services', () => {
    const owners = new Map<string, string>();
    for (const service of SERVICES) {
      for (const hint of [service.name, ...(service.titleHints ?? [])]) {
        const key = hint.toLowerCase();
        const owner = owners.get(key);
        expect(owner === undefined || owner === service.id, `${hint}: ${owner}`).toBe(true);
        owners.set(key, service.id);
      }
    }
  });
});
