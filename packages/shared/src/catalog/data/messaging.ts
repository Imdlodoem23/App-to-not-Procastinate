import type { Service } from '../types';

/*
 * Messaging (web clients and desktop apps).
 * - Telegram Desktop talks to raw IP addresses (MTProto), so the hosts file cannot stop
 *   it: the process watcher does. The *.web.telegram.org hosts are the web client's
 *   data centers.
 * - WhatsApp media hosts use per-region names under whatsapp.net that cannot be
 *   enumerated; the pages and the desktop app are what matters.
 */
export const MESSAGING_SERVICES: readonly Service[] = [
  {
    id: 'discord',
    name: 'Discord',
    categories: ['messaging'],
    domains: [
      'discord.com',
      'www.discord.com',
      'ptb.discord.com',
      'canary.discord.com',
      'discordapp.com',
      'www.discordapp.com',
      'cdn.discordapp.com',
      'discordapp.net',
      'media.discordapp.net',
      'images-ext-1.discordapp.net',
      'discord.gg',
      'gateway.discord.gg',
      'discord.media',
      'discord.new',
      'dis.gd',
    ],
    appIds: ['discord'],
    aliases: ['discord', 'discor', 'disord', 'discordd', 'dizcord'],
    monogram: 'DC',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    categories: ['messaging'],
    domains: [
      'whatsapp.com',
      'www.whatsapp.com',
      'web.whatsapp.com',
      'api.whatsapp.com',
      'chat.whatsapp.com',
      'wa.me',
      'whatsapp.net',
      'static.whatsapp.net',
      'mmg.whatsapp.net',
      'pps.whatsapp.net',
    ],
    appIds: ['whatsapp'],
    aliases: [
      'whatsapp',
      'whatsapp web',
      'whatsap',
      'whats',
      'wasap',
      'wasa',
      'guasap',
      'watsap',
      'wsp',
      'wpp',
      'wa',
    ],
    monogram: 'WA',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    categories: ['messaging'],
    domains: [
      'telegram.org',
      'www.telegram.org',
      'web.telegram.org',
      'desktop.telegram.org',
      'pluto.web.telegram.org',
      'venus.web.telegram.org',
      'aurora.web.telegram.org',
      'vesta.web.telegram.org',
      'flora.web.telegram.org',
      't.me',
      'telegram.me',
      'telesco.pe',
    ],
    appIds: ['telegram'],
    aliases: ['telegram', 'telegram web', 'telegran', 'telgram', 'tg'],
    monogram: 'TG',
    titleHints: ['Telegram Web'],
  },
  {
    id: 'messenger',
    name: 'Messenger',
    categories: ['messaging'],
    domains: ['messenger.com', 'www.messenger.com', 'm.me'],
    aliases: ['messenger', 'facebook messenger', 'mesenger', 'fb messenger'],
    monogram: 'MS',
  },
];
