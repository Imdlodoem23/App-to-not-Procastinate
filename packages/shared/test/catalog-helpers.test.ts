import { describe, expect, it } from 'vitest';
import {
  ALWAYS_ALLOWED_HOSTS,
  CATALOG_VERSION,
  CATEGORIES,
  SERVICES,
  STUDY_WHITELIST,
  aliasKey,
  allDistractionTargets,
  catalogSnapshot,
  expandDomainVariants,
  findAppByProcessName,
  findCategoryByAlias,
  findServiceByAlias,
  findServiceByDomain,
  findServiceByProcessName,
  findServiceByWindowTitle,
  getApp,
  getCategory,
  getService,
  isAllowedInStudyWhitelist,
  isAlwaysAllowedHost,
  isDomainAllowedInWhitelist,
  isProtectedProcessName,
  isValidDomain,
  isValidProcessName,
  matchesHostPattern,
  normalizeAlias,
  normalizeDomain,
  resolveTargets,
  servicesInCategory,
  studyWhitelistDomains,
  studyWhitelistHostPatterns,
  studyWhitelistProcesses,
} from '../src/catalog';

describe('normalizeDomain', () => {
  it.each([
    ['youtube.com', 'youtube.com'],
    ['  YouTube.COM  ', 'youtube.com'],
    ['https://www.youtube.com/watch?v=abc#t=1', 'www.youtube.com'],
    ['http://m.youtube.com:8080/feed', 'm.youtube.com'],
    ['www.tiktok.com/@user', 'www.tiktok.com'],
    ['//reddit.com/r/spain', 'reddit.com'],
    ['user:pass@instagram.com', 'instagram.com'],
    ['example.com.', 'example.com'],
    ['*.tiktok.com', 'tiktok.com'],
    ['.twitch.tv', 'twitch.tv'],
    ['ñandú.es', 'xn--and-6ma2c.es'],
    ['ＹＯＵＴＵＢＥ.com', 'youtube.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['xn--and-6ma2c.es', 'xn--and-6ma2c.es'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'localhost',
    'youtube',
    '127.0.0.1',
    'http://0x7f.1',
    '[::1]',
    'http://[2001:db8::1]/',
    'you tube.com',
    'foo_bar.com',
    '-foo.com',
    'example..com',
    'chrome://extensions',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'javascript:alert(1)',
    `${'a'.repeat(64)}.com`,
    'x'.repeat(3000),
  ])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });

  it('rejects non-strings without throwing', () => {
    expect(normalizeDomain(undefined as unknown as string)).toBeNull();
    expect(normalizeDomain(42 as unknown as string)).toBeNull();
  });
});

describe('isValidDomain', () => {
  it('accepts canonical domains only', () => {
    expect(isValidDomain('youtube.com')).toBe(true);
    expect(isValidDomain('youtubei.googleapis.com')).toBe(true);
    expect(isValidDomain('cloud.microsoft')).toBe(true);
    expect(isValidDomain('xn--and-6ma2c.es')).toBe(true);
    expect(isValidDomain('YouTube.com')).toBe(false);
    expect(isValidDomain('youtube.com.')).toBe(false);
    expect(isValidDomain('https://youtube.com')).toBe(false);
    expect(isValidDomain('1.2.3.4')).toBe(false);
    expect(isValidDomain('com')).toBe(false);
    expect(isValidDomain('a-.com')).toBe(false);
    expect(isValidDomain(`${'a.'.repeat(126)}com`)).toBe(false);
  });
});

describe('isValidProcessName', () => {
  it.each(['Discord.exe', 'Steam Helper', 'Battle.net Launcher.exe', 'Céntrate.exe', 'steam_osx'])(
    'accepts %j',
    (name) => expect(isValidProcessName(name)).toBe(true),
  );

  it.each([
    '',
    ' Discord.exe',
    'Discord.exe ',
    'C:\\Games\\steam.exe',
    '/usr/bin/steam',
    '..',
    '.',
    'steam\u0000.exe',
    'steam\n.exe',
    'exe.\u202Eevil',
    'zero\u200Bwidth',
    '*.exe',
    'a:b',
    'x'.repeat(129),
  ])('rejects %j', (name) => expect(isValidProcessName(name)).toBe(false));

  it('allows exactly 128 characters', () => {
    expect(isValidProcessName('x'.repeat(128))).toBe(true);
  });
});

describe('isProtectedProcessName', () => {
  it('protects system processes and Céntrate itself, ignoring case and .exe', () => {
    for (const name of [
      'csrss.exe',
      'CSRSS.EXE',
      'csrss',
      'explorer.exe',
      'Taskmgr.exe',
      'WindowServer',
      'windowserver',
      'systemd',
      'Céntrate.exe',
      'Ce\u0301ntrate.exe',
      'centrate-guardian',
    ]) {
      expect(isProtectedProcessName(name), name).toBe(true);
    }
    expect(isProtectedProcessName('Discord.exe')).toBe(false);
    expect(isProtectedProcessName('chrome.exe')).toBe(false);
  });

  it('follows the guardian deny-list rules: accents, .app and the Céntrate prefixes', () => {
    for (const name of [
      'Céntrate Setup 0.1.0.exe',
      'CENTRATE.exe',
      'centrate',
      'Centrate Helper (Something New)',
      'Uninstall Céntrate.exe',
      'uninstall centrate 2.exe',
      'Finder.app',
      'Céntrate.app',
      '[System Process]',
      'consent.exe',
      'taskhostw.exe',
      'SecurityAgent',
      'kwin',
      'sshd-session',
    ]) {
      expect(isProtectedProcessName(name), name).toBe(true);
    }
    for (const name of ['', '   ', 'Central', 'Centralita.exe', 'explorer2.exe', 'systemd-games']) {
      expect(isProtectedProcessName(name), name).toBe(false);
    }
    expect(isProtectedProcessName(undefined as unknown as string)).toBe(false);
  });

  it('protects accessibility tools on every platform', () => {
    for (const name of [
      'osk.exe',
      'Narrator.exe',
      'Magnify.exe',
      'AtBroker.exe',
      'nvda.exe',
      'VoiceOver',
      'orca',
    ]) {
      expect(isProtectedProcessName(name), name).toBe(true);
    }
    expect(resolveTargets({ processNames: ['osk.exe', 'VoiceOver', 'orca'] }, 'win')).toEqual({
      domains: [],
      excludedDomains: [],
      processes: [],
    });
  });
});

describe('expandDomainVariants', () => {
  it.each([
    ['example.com', ['example.com', 'www.example.com']],
    ['www.example.com', ['www.example.com', 'example.com']],
    ['https://Example.com/path', ['example.com', 'www.example.com']],
    ['bbc.co.uk', ['bbc.co.uk', 'www.bbc.co.uk']],
    ['www.bbc.co.uk', ['www.bbc.co.uk', 'bbc.co.uk']],
    ['m.example.com', ['m.example.com']],
    ['news.bbc.co.uk', ['news.bbc.co.uk']],
    ['www.com', ['www.com']],
    ['not a domain', []],
  ])('%j → %j', (input, expected) => {
    expect(expandDomainVariants(input)).toEqual(expected);
  });
});

describe('isDomainAllowedInWhitelist', () => {
  const whitelist = ['wikipedia.org', 'docs.google.com', 'https://www.deepl.com/translator'];

  it('matches the entry and its subdomains', () => {
    expect(isDomainAllowedInWhitelist('wikipedia.org', whitelist)).toBe(true);
    expect(isDomainAllowedInWhitelist('es.m.wikipedia.org', whitelist)).toBe(true);
    expect(isDomainAllowedInWhitelist('https://docs.google.com/document/d/1', whitelist)).toBe(
      true,
    );
    expect(isDomainAllowedInWhitelist('www.deepl.com', whitelist)).toBe(true);
  });

  it('does not match parents, siblings or look-alikes', () => {
    expect(isDomainAllowedInWhitelist('google.com', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('drive.google.com', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('notwikipedia.org', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('wikipedia.org.evil.com', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('deepl.com', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('not a domain', whitelist)).toBe(false);
    expect(isDomainAllowedInWhitelist('wikipedia.org', [])).toBe(false);
  });

  it('also allows hosts matched by anchored host patterns', () => {
    const patterns = ['^[a-z0-9-]+-docs\\.googleusercontent\\.com$'];
    expect(
      isDomainAllowedInWhitelist('doc-0s-8c-docs.googleusercontent.com', whitelist, patterns),
    ).toBe(true);
    expect(
      isDomainAllowedInWhitelist('https://doc-0s-8c-docs.googleusercontent.com/x', [], patterns),
    ).toBe(true);
    expect(isDomainAllowedInWhitelist('googleusercontent.com', whitelist, patterns)).toBe(false);
    expect(isDomainAllowedInWhitelist('yt3.googleusercontent.com', whitelist, patterns)).toBe(
      false,
    );
    expect(
      isDomainAllowedInWhitelist('a-docs.googleusercontent.com.evil.com', whitelist, patterns),
    ).toBe(false);
  });
});

describe('matchesHostPattern', () => {
  it('matches canonical hosts against anchored patterns only', () => {
    expect(matchesHostPattern('lh3.google.com', '^lh[3-7]\\.google\\.com$')).toBe(true);
    expect(matchesHostPattern('lh8.google.com', '^lh[3-7]\\.google\\.com$')).toBe(false);
    // Unanchored and invalid patterns match nothing.
    expect(matchesHostPattern('lh3.google.com', 'lh3')).toBe(false);
    expect(matchesHostPattern('lh3.google.com', '^lh3\\.google\\.com')).toBe(false);
    expect(matchesHostPattern('lh3.google.com', '^(lh3$')).toBe(false);
    // Hosts must be canonical.
    expect(matchesHostPattern('LH3.google.com', '^.*$')).toBe(false);
    expect(matchesHostPattern('not a host', '^.*$')).toBe(false);
  });
});

describe('lookups', () => {
  it('getService, getCategory and getApp', () => {
    expect(getService('youtube')?.name).toBe('YouTube');
    expect(getService('x-twitter')?.name).toBe('X (Twitter)');
    expect(getService('nope')).toBeUndefined();
    expect(getCategory('games')?.name).toBe('Juegos');
    expect(getCategory('nope')).toBeUndefined();
    expect(getApp('discord')?.processes.win).toContain('Discord.exe');
    expect(getApp('nope')).toBeUndefined();
  });

  it('servicesInCategory keeps catalog order and skips opt-in services', () => {
    const social = servicesInCategory('social').map((s) => s.id);
    expect(social.slice(0, 3)).toEqual(['tiktok', 'instagram', 'x-twitter']);
    expect(social).not.toContain('linkedin');
    expect(servicesInCategory('nope')).toEqual([]);
    const total = CATEGORIES.reduce((n, c) => n + servicesInCategory(c.id).length, 0);
    expect(total).toBe(SERVICES.filter((s) => s.categories.length > 0).length);
  });

  it('findServiceByDomain matches exact hosts, subdomains and URLs', () => {
    expect(findServiceByDomain('youtu.be')?.id).toBe('youtube');
    expect(findServiceByDomain('https://es.m.youtube.com/watch?v=1')?.id).toBe('youtube');
    expect(findServiceByDomain('atv-ps.amazon.com')?.id).toBe('prime-video');
    expect(findServiceByDomain('store.epicgames.com')?.id).toBe('epic-games');
    expect(findServiceByDomain('www.roblox.com')?.id).toBe('roblox');
    expect(findServiceByDomain('rr3.googlevideo.com')).toBeUndefined();
    expect(findServiceByDomain('foo.googleapis.com')).toBeUndefined();
    expect(findServiceByDomain('com')).toBeUndefined();
    expect(findServiceByDomain('')).toBeUndefined();
  });

  it('findServiceByDomain gives no service to hosts that stay reachable during a block', () => {
    for (const host of [
      'accounts.youtube.com',
      'https://accounts.youtube.com/accounts/SetSID',
      'aws.amazon.com',
      'docs.aws.amazon.com',
      'console.aws.amazon.com',
      'read.amazon.com',
      'leer.amazon.es',
      'dev.epicgames.com',
      'www.epicgames.com',
      'education.minecraft.net',
      'create.roblox.com',
    ]) {
      expect(findServiceByDomain(host), host).toBeUndefined();
    }
    // Their parents still belong to the service.
    expect(findServiceByDomain('www.amazon.com')?.id).toBe('amazon');
    expect(findServiceByDomain('smile.amazon.com')?.id).toBe('amazon');
    expect(findServiceByDomain('m.youtube.com')?.id).toBe('youtube');
    expect(findServiceByDomain('minecraft.net')?.id).toBe('minecraft');
  });

  it('isAlwaysAllowedHost covers accounts.youtube.com and its subdomains only', () => {
    expect(ALWAYS_ALLOWED_HOSTS).toContain('accounts.youtube.com');
    expect(isAlwaysAllowedHost('accounts.youtube.com')).toBe(true);
    expect(isAlwaysAllowedHost('https://accounts.youtube.com/accounts/SetSID?x=1')).toBe(true);
    expect(isAlwaysAllowedHost('www.youtube.com')).toBe(false);
    expect(isAlwaysAllowedHost('youtube.com')).toBe(false);
    expect(isAlwaysAllowedHost('not a host')).toBe(false);
  });

  it('findAppByProcessName follows each platform case rules', () => {
    expect(findAppByProcessName('discord.exe', 'win')?.id).toBe('discord');
    expect(findAppByProcessName('STEAM.EXE', 'win')?.id).toBe('steam');
    expect(findAppByProcessName('steam_osx', 'mac')?.id).toBe('steam');
    expect(findAppByProcessName('discord', 'linux')?.id).toBe('discord');
    expect(findAppByProcessName('STEAM', 'linux')).toBeUndefined();
    expect(findAppByProcessName('Discord.exe', 'linux')).toBeUndefined();
    expect(findAppByProcessName('notepad.exe', 'win')).toBeUndefined();
  });

  it('findServiceByProcessName maps processes to services', () => {
    expect(findServiceByProcessName('RobloxPlayerBeta.exe', 'win')?.id).toBe('roblox');
    expect(findServiceByProcessName('LeagueClientUx.exe', 'win')?.id).toBe('league-of-legends');
    expect(findServiceByProcessName('WhatsApp.Root.exe', 'win')?.id).toBe('whatsapp');
    // Category-wide apps have no single service.
    expect(findServiceByProcessName('cs2.exe', 'win')).toBeUndefined();
    expect(findAppByProcessName('cs2.exe', 'win')?.id).toBe('popular-pc-games');
  });

  it('findServiceByWindowTitle reads title segments, not words', () => {
    expect(findServiceByWindowTitle('(12) Lo-fi beats - YouTube - Google Chrome')?.id).toBe(
      'youtube',
    );
    expect(findServiceByWindowTitle('YouTube')?.id).toBe('youtube');
    expect(findServiceByWindowTitle('Home / X — Mozilla Firefox')?.id).toBe('x-twitter');
    expect(findServiceByWindowTitle('Netflix - Microsoft\u200B Edge')?.id).toBe('netflix');
    expect(findServiceByWindowTitle('#general | Clase 2B - Discord')?.id).toBe('discord');
    expect(findServiceByWindowTitle('(3) WhatsApp')?.id).toBe('whatsapp');
    expect(findServiceByWindowTitle('Amazon.es: compra online')?.id).toBe('amazon');
    // The site name wins over a page that mentions another service.
    expect(findServiceByWindowTitle('Netflix trailer - YouTube')?.id).toBe('youtube');
    expect(findServiceByWindowTitle('Apuntes sobre YouTube - Word')).toBeUndefined();
    expect(findServiceByWindowTitle('Tema 3: la Revolución francesa')).toBeUndefined();
    expect(findServiceByWindowTitle('')).toBeUndefined();
  });

  it.each([
    'YouTube - Wikipedia, la enciclopedia libre - Google Chrome',
    'youtube - Buscar con Google - Google Chrome',
    'Minecraft - Wikipedia, la enciclopedia libre - Google Chrome',
    'ABC - Wikipedia, la enciclopedia libre',
    'Tema 3: X - Documentos de Google - Google Chrome',
    'Despejar: x - Documentos de Google',
    'Despejar: x',
    'X',
    'Max - Documentos de Google',
    'Steam - Word',
    'Netflix: guía de estudio - Wikipedia — Mozilla Firefox',
    'Marca - Mi blog de apuntes',
    'Google Chrome',
  ])('findServiceByWindowTitle ignores page titles: %j', (title) => {
    expect(findServiceByWindowTitle(title)).toBeUndefined();
  });

  it.each([
    ['WhatsApp Web', 'whatsapp'],
    ['WhatsApp Web - Google Chrome', 'whatsapp'],
    ['Epic Games Launcher', 'epic-games'],
    ['Minecraft Launcher', 'minecraft'],
    ['TikTok - Make Your Day - Google Chrome', 'tiktok'],
    ['Stranger Things | Netflix', 'netflix'],
    ['Prime Video: The Boys - Google Chrome', 'prime-video'],
    ['Amazon.es: compra online de electrónica, libros, deporte y más', 'amazon'],
    ['(1) Inicio / X - Google Chrome', 'x-twitter'],
    ['Lo-fi beats - YouTube - [InPrivate] - Microsoft\u200B Edge', 'youtube'],
    ['Lo-fi beats - YouTube and 3 more pages - Microsoft\u200B Edge', 'youtube'],
    ['Lo-fi beats - YouTube — Navegación privada de Mozilla Firefox', 'youtube'],
  ])('findServiceByWindowTitle(%j) → %s', (title, id) => {
    expect(findServiceByWindowTitle(title)?.id).toBe(id);
  });
});

describe('aliases', () => {
  it('normalizeAlias and aliasKey', () => {
    expect(normalizeAlias('  Vídeo   y Streaming ')).toBe('video y streaming');
    expect(normalizeAlias('Disney+')).toBe('disney plus');
    expect(normalizeAlias('RR.SS.')).toBe('rr ss');
    expect(aliasKey('Tik-Tok')).toBe('tiktok');
    expect(aliasKey('you tube')).toBe('youtube');
  });

  it.each([
    ['yt', 'youtube'],
    ['YouTube', 'youtube'],
    ['you tube', 'youtube'],
    ['youtbe', 'youtube'],
    ['yutub', 'youtube'],
    ['insta', 'instagram'],
    ['IG', 'instagram'],
    ['tik tok', 'tiktok'],
    ['Tik-Tok', 'tiktok'],
    ['tictoc', 'tiktok'],
    ['twitter', 'x-twitter'],
    ['x', 'x-twitter'],
    ['X (Twitter)', 'x-twitter'],
    ['tuiter', 'x-twitter'],
    ['face', 'facebook'],
    ['fb', 'facebook'],
    ['netflis', 'netflix'],
    ['twich', 'twitch'],
    ['disney', 'disney-plus'],
    ['Disney+', 'disney-plus'],
    ['disney plus', 'disney-plus'],
    ['prime', 'prime-video'],
    ['amazon prime', 'prime-video'],
    ['amazon', 'amazon'],
    ['hbo', 'hbo-max'],
    ['max', 'hbo-max'],
    ['Movistar+', 'movistar-plus'],
    ['wasap', 'whatsapp'],
    ['lol', 'league-of-legends'],
    ['maincra', 'minecraft'],
    ['el país', 'el-pais'],
    ['20 minutos', '20minutos'],
    ['m.youtube.com/watch?v=1', 'youtube'],
    ['https://www.netflix.com/browse', 'netflix'],
    ['tt', 'tiktok'],
    ['mine', 'minecraft'],
    ['ajedrez', 'chess-com'],
    ['anime', 'crunchyroll'],
    ['fifa', 'ea-sports-fc'],
    ['fc', 'ea-sports-fc'],
    ['FC 26', 'ea-sports-fc'],
    ['flashscore', 'flashscore'],
    ['sofascore', 'sofascore'],
    ['besoccer', 'besoccer'],
    ['geforce now', 'geforce-now'],
    ['xcloud', 'xbox-cloud-gaming'],
    ['now.gg', 'now-gg'],
    ['1001 juegos', '1001juegos'],
    ['https://play.geforcenow.com/mall', 'geforce-now'],
    ['https://www.xbox.com/es-ES/play', 'xbox-cloud-gaming'],
  ])('findServiceByAlias(%j) → %s', (text, id) => {
    expect(findServiceByAlias(text)?.id).toBe(id);
  });

  it.each(['', '   ', 'redes', 'deberes', 'mates', 'example.com', 'no veo youtube'])(
    'findServiceByAlias(%j) → undefined',
    (text) => expect(findServiceByAlias(text)).toBeUndefined(),
  );

  it.each([
    ['redes', 'social'],
    ['RRSS', 'social'],
    ['rr.ss.', 'social'],
    ['redes sociales', 'social'],
    ['juegos', 'games'],
    ['videojuegos', 'games'],
    ['series', 'video'],
    ['streaming', 'video'],
    ['Vídeo y streaming', 'video'],
    ['compras', 'shopping'],
    ['noticias', 'news'],
    ['deportes', 'news'],
    ['mensajes', 'messaging'],
    ['chats', 'messaging'],
    ['Mensajería', 'messaging'],
  ])('findCategoryByAlias(%j) → %s', (text, id) => {
    expect(findCategoryByAlias(text)?.id).toBe(id);
  });

  it('keeps service and category words apart', () => {
    expect(findCategoryByAlias('youtube')).toBeUndefined();
    expect(findServiceByAlias('juegos')).toBeUndefined();
    expect(findServiceByAlias('juegos.com')?.id).toBe('juegos-com');
    expect(findCategoryByAlias('')).toBeUndefined();
  });
});

describe('resolveTargets', () => {
  it('expands a service into its domains and apps', () => {
    const result = resolveTargets({ serviceIds: ['discord'] }, 'win');
    expect(result.domains).toEqual([...(getService('discord')?.domains ?? [])].sort());
    expect(result.processes).toEqual(['Discord.exe', 'DiscordCanary.exe', 'DiscordPTB.exe']);
  });

  it('uses the process names of the requested platform', () => {
    expect(resolveTargets({ serviceIds: ['steam'] }, 'mac').processes).toEqual([
      'Steam Helper',
      'steam_osx',
    ]);
    expect(resolveTargets({ serviceIds: ['roblox'] }, 'linux').processes).toEqual([]);
    expect(resolveTargets({ serviceIds: ['youtube'] }, 'win').processes).toEqual([]);
  });

  it('expands a category into all its services and category-wide apps', () => {
    const result = resolveTargets({ categoryIds: ['games'] }, 'win');
    for (const service of servicesInCategory('games')) {
      for (const domain of service.domains) expect(result.domains).toContain(domain);
    }
    expect(result.processes).toEqual(
      expect.arrayContaining(['steam.exe', 'RobloxPlayerBeta.exe', 'VALORANT.exe', 'cs2.exe']),
    );
    expect(result.domains).not.toContain('youtube.com');
  });

  it('normalizes and expands custom domains, dropping invalid ones', () => {
    const result = resolveTargets(
      { domains: ['https://Example.com/x', 'm.foo.org', 'not a domain', '10.0.0.1'] },
      'linux',
    );
    expect(result).toEqual({
      domains: ['example.com', 'm.foo.org', 'www.example.com'],
      excludedDomains: [],
      processes: [],
    });
  });

  it('adds apps and custom processes, dropping invalid and protected ones', () => {
    const result = resolveTargets(
      {
        appIds: ['telegram', 'nope'],
        processNames: [' MyGame.exe ', 'C:\\x\\evil.exe', 'explorer.exe', 'csrss', 'mygame.EXE'],
      },
      'win',
    );
    expect(result).toEqual({
      domains: [],
      excludedDomains: [],
      processes: ['MyGame.exe', 'Telegram.exe'],
    });
  });

  it('dedupes case-insensitively on Windows and macOS but not on Linux', () => {
    expect(resolveTargets({ processNames: ['Game', 'game', 'GAME'] }, 'mac').processes).toEqual([
      'Game',
    ]);
    expect(resolveTargets({ serviceIds: ['discord'] }, 'linux').processes).toEqual([
      'Discord',
      'discord',
      'DiscordCanary',
      'DiscordPTB',
    ]);
  });

  it('returns unique sorted domains when selections overlap', () => {
    const result = resolveTargets(
      {
        serviceIds: ['youtube', 'youtube', 'tiktok'],
        categoryIds: ['video'],
        domains: ['youtube.com', 'www.youtube.com'],
      },
      'win',
    );
    expect(new Set(result.domains).size).toBe(result.domains.length);
    expect(result.domains).toEqual([...result.domains].sort());
    expect(result.domains).toContain('tiktok.com');
    expect(result.domains).toContain('netflix.com');
  });

  it('ignores unknown ids and empty selections', () => {
    const empty = { domains: [], excludedDomains: [], processes: [] };
    expect(resolveTargets({}, 'win')).toEqual(empty);
    expect(
      resolveTargets({ serviceIds: ['nope'], categoryIds: ['nope'], appIds: ['nope'] }, 'mac'),
    ).toEqual(empty);
  });

  it('never blocks accounts.youtube.com (Google sign-in) and lists it as an exception', () => {
    const youtube = resolveTargets({ serviceIds: ['youtube'] }, 'win');
    expect(youtube.domains).toContain('youtube.com');
    expect(youtube.domains).not.toContain('accounts.youtube.com');
    expect(youtube.excludedDomains).toEqual(['accounts.youtube.com']);
    for (const selection of [{ categoryIds: ['video'] }, { domains: ['youtube.com'] }]) {
      expect(resolveTargets(selection, 'win').excludedDomains).toContain('accounts.youtube.com');
    }
    // Typed on purpose, it is still dropped.
    const typed = resolveTargets(
      { domains: ['accounts.youtube.com', 'x.accounts.youtube.com'] },
      'win',
    );
    expect(typed).toEqual({ domains: [], excludedDomains: [], processes: [] });
    // No exception without a blocked parent.
    expect(resolveTargets({ serviceIds: ['tiktok'] }, 'win').excludedDomains).toEqual([]);
  });

  it('lists the selected services excluded subdomains for the extension', () => {
    expect(resolveTargets({ serviceIds: ['amazon'] }, 'win').excludedDomains).toEqual([
      'aws.amazon.com',
      'leer.amazon.es',
      'read.amazon.com',
    ]);
    const games = resolveTargets({ categoryIds: ['games'] }, 'win');
    expect(games.excludedDomains).toEqual(
      expect.arrayContaining([
        'create.roblox.com',
        'dev.epicgames.com',
        'education.minecraft.net',
        'www.epicgames.com',
      ]),
    );
    for (const host of games.excludedDomains) expect(games.domains).not.toContain(host);
    expect(resolveTargets({ serviceIds: ['youtube'] }, 'win').excludedDomains).not.toContain(
      'aws.amazon.com',
    );
  });

  it('blocks an excluded subdomain the user typed explicitly', () => {
    const result = resolveTargets(
      { serviceIds: ['amazon'], domains: ['docs.aws.amazon.com'] },
      'win',
    );
    expect(result.domains).toContain('docs.aws.amazon.com');
    expect(result.excludedDomains).toEqual(['leer.amazon.es', 'read.amazon.com']);
  });
});

describe('allDistractionTargets', () => {
  it('blocks every category (punishment level 1) and nothing opt-in', () => {
    const everything = resolveTargets({ categoryIds: CATEGORIES.map((c) => c.id) }, 'win');
    const result = allDistractionTargets('win');
    expect(result).toEqual(everything);
    for (const id of ['youtube', 'tiktok', 'steam', 'discord', 'amazon', 'marca']) {
      for (const domain of getService(id)?.domains ?? []) expect(result.domains).toContain(domain);
    }
    expect(result.domains).not.toContain('linkedin.com');
    expect(result.processes).not.toContain('Spotify.exe');
    expect(result.processes).toContain('Discord.exe');
    expect(result.excludedDomains).toContain('accounts.youtube.com');
    expect(result.excludedDomains).toContain('aws.amazon.com');
  });

  it('never includes a protected process', () => {
    for (const platform of ['win', 'mac', 'linux'] as const) {
      for (const name of allDistractionTargets(platform).processes) {
        expect(isProtectedProcessName(name), name).toBe(false);
      }
    }
  });
});

describe('study whitelist helpers', () => {
  it('flattens domains, unique and sorted', () => {
    const domains = studyWhitelistDomains();
    expect(domains).toEqual([...new Set(domains)].sort());
    expect(domains).toContain('classroom.google.com');
  });

  it('lists study processes per platform', () => {
    expect(studyWhitelistProcesses('win')).toEqual(
      expect.arrayContaining(['WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE', 'Code.exe']),
    );
    expect(studyWhitelistProcesses('mac')).toContain('Microsoft Word');
    expect(studyWhitelistProcesses('linux')).toContain('soffice.bin');
  });

  it('keeps browsers open so the study websites stay reachable', () => {
    expect(studyWhitelistProcesses('win')).toEqual(
      expect.arrayContaining(['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe']),
    );
    expect(studyWhitelistProcesses('mac')).toEqual(
      expect.arrayContaining(['Google Chrome', 'Safari', 'firefox', 'Microsoft Edge']),
    );
    expect(studyWhitelistProcesses('linux')).toEqual(
      expect.arrayContaining(['chrome', 'firefox', 'chromium']),
    );
    expect(studyWhitelistProcesses('win')).toContain('Zoom.exe');
  });

  it('lists the host patterns, unique and sorted', () => {
    const patterns = studyWhitelistHostPatterns();
    expect(patterns).toEqual([...new Set(patterns)].sort());
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('isAllowedInStudyWhitelist combines defaults, patterns, always-allowed hosts and extras', () => {
    for (const host of [
      'classroom.google.com',
      'accounts.youtube.com',
      'doc-0s-8c-docs.googleusercontent.com',
      'lh3.googleusercontent.com',
      'https://es.wikipedia.org/wiki/Roma',
    ]) {
      expect(isAllowedInStudyWhitelist(host), host).toBe(true);
    }
    expect(isAllowedInStudyWhitelist('www.youtube.com')).toBe(false);
    expect(isAllowedInStudyWhitelist('aulavirtual.example.edu')).toBe(false);
    expect(isAllowedInStudyWhitelist('aulavirtual.example.edu', ['example.edu'])).toBe(true);
    expect(isAllowedInStudyWhitelist('not a host', ['example.edu'])).toBe(false);
  });
});

describe('catalogSnapshot', () => {
  it('is JSON-serializable and complete', () => {
    const snapshot = catalogSnapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.version).toBe(CATALOG_VERSION);
    expect(snapshot.categories).toHaveLength(CATEGORIES.length);
    expect(snapshot.services).toHaveLength(SERVICES.length);
    expect(snapshot.apps.length).toBeGreaterThan(0);
    expect(snapshot.studyWhitelist.length).toBeGreaterThan(0);
    expect(snapshot.studyAppWhitelist.length).toBeGreaterThan(0);
    expect(snapshot.protectedProcesses).toContain('csrss.exe');
    expect(snapshot.alwaysAllowedHosts).toEqual([...ALWAYS_ALLOWED_HOSTS]);
    expect(snapshot.services.find((s) => s.id === 'amazon')?.excludedSubdomains).toContain(
      'aws.amazon.com',
    );
    expect(
      snapshot.studyWhitelist.find((s) => s.id === 'google-workspace')?.hostPatterns.length,
    ).toBeGreaterThan(0);
    expect(snapshot.studyWhitelist).toHaveLength(STUDY_WHITELIST.length);
  });

  it('always fills optional fields so typed consumers get a stable shape', () => {
    const snapshot = catalogSnapshot();
    for (const service of snapshot.services) {
      expect(Array.isArray(service.appIds)).toBe(true);
      expect(Array.isArray(service.titleHints)).toBe(true);
      expect(Array.isArray(service.excludedSubdomains)).toBe(true);
      expect(typeof service.educationalCapable).toBe('boolean');
    }
    for (const site of snapshot.studyWhitelist) expect(Array.isArray(site.hostPatterns)).toBe(true);
    expect(snapshot.services.find((s) => s.id === 'tiktok')?.excludedSubdomains).toEqual([]);
    for (const category of snapshot.categories) expect(Array.isArray(category.appIds)).toBe(true);
    expect(snapshot.services.find((s) => s.id === 'youtube')?.educationalCapable).toBe(true);
    expect(snapshot.services.find((s) => s.id === 'tiktok')?.appIds).toEqual([]);
  });

  it('returns copies that can be changed without touching the catalog', () => {
    const snapshot = catalogSnapshot();
    snapshot.services[0]?.domains.push('evil.example');
    snapshot.apps[0]?.processes.win.push('evil.exe');
    expect(SERVICES[0]?.domains).not.toContain('evil.example');
    expect(catalogSnapshot().apps[0]?.processes.win).not.toContain('evil.exe');
  });
});
