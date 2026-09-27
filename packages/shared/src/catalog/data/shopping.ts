import type { Service } from '../types';

/*
 * Online shopping.
 * - Amazon image hosts (m.media-amazon.com, ssl-images-amazon.com) are shared with Prime
 *   Video and many other sites, and alicdn.com is shared by all Alibaba shops: none is
 *   listed. Never add amazonaws.com (AWS): half of the internet runs on it.
 * - The extension matches catalog hosts together with their subdomains, so amazon.com
 *   also covers AWS (aws.amazon.com: docs, console, sign-in) and the Kindle Cloud Reader
 *   (read.amazon.com, leer.amazon.es). Those are `excludedSubdomains`: they stay
 *   reachable during a shopping block. Prime Video's atv-ps.amazon.com is still caught,
 *   which is fine (it is a distraction too).
 */
export const SHOPPING_SERVICES: readonly Service[] = [
  {
    id: 'amazon',
    name: 'Amazon',
    categories: ['shopping'],
    domains: [
      'amazon.es',
      'www.amazon.es',
      'amazon.com',
      'www.amazon.com',
      'amazon.co.uk',
      'www.amazon.co.uk',
      'amazon.de',
      'www.amazon.de',
      'amazon.fr',
      'www.amazon.fr',
      'amazon.it',
      'www.amazon.it',
      'amazon.com.mx',
      'www.amazon.com.mx',
      'amzn.to',
      'amzn.eu',
      'a.co',
    ],
    excludedSubdomains: ['aws.amazon.com', 'read.amazon.com', 'leer.amazon.es'],
    aliases: ['amazon', 'amazon.es', 'amazon.com', 'amazn', 'amazom', 'amason'],
    monogram: 'AZ',
    titleHints: ['Amazon.es', 'Amazon.com'],
  },
  {
    id: 'aliexpress',
    name: 'AliExpress',
    categories: ['shopping'],
    domains: [
      'aliexpress.com',
      'www.aliexpress.com',
      'es.aliexpress.com',
      'm.aliexpress.com',
      'login.aliexpress.com',
      'a.aliexpress.com',
      's.click.aliexpress.com',
      'aliexpress.us',
      'www.aliexpress.us',
    ],
    aliases: ['aliexpress', 'ali express', 'ali', 'aliexpres', 'aliespres', 'aliexprés'],
    monogram: 'AE',
  },
  {
    id: 'shein',
    name: 'Shein',
    categories: ['shopping'],
    domains: [
      'shein.com',
      'www.shein.com',
      'es.shein.com',
      'm.shein.com',
      'us.shein.com',
      'img.ltwebstatic.com',
    ],
    aliases: ['shein', 'shien', 'sheín', 'she in'],
    monogram: 'SH',
  },
  {
    id: 'temu',
    name: 'Temu',
    categories: ['shopping'],
    domains: ['temu.com', 'www.temu.com', 'share.temu.com', 'img.kwcdn.com', 'aimg.kwcdn.com'],
    aliases: ['temu', 'temú'],
    monogram: 'TE',
  },
  {
    id: 'zalando',
    name: 'Zalando',
    categories: ['shopping'],
    domains: [
      'zalando.es',
      'www.zalando.es',
      'zalando.com',
      'www.zalando.com',
      'zalando-prive.es',
      'www.zalando-prive.es',
    ],
    aliases: ['zalando', 'zalando prive'],
    monogram: 'ZA',
  },
  {
    id: 'ebay',
    name: 'eBay',
    categories: ['shopping'],
    domains: [
      'ebay.es',
      'www.ebay.es',
      'ebay.com',
      'www.ebay.com',
      'signin.ebay.es',
      'signin.ebay.com',
      'ebay.us',
      'i.ebayimg.com',
      'ebaystatic.com',
      'ir.ebaystatic.com',
    ],
    aliases: ['ebay', 'e bay', 'ebei'],
    monogram: 'EB',
  },
  {
    id: 'wallapop',
    name: 'Wallapop',
    categories: ['shopping'],
    domains: [
      'wallapop.com',
      'www.wallapop.com',
      'es.wallapop.com',
      'api.wallapop.com',
      'cdn.wallapop.com',
    ],
    aliases: ['wallapop', 'walapop', 'wallapo', 'guallapop', 'wallapp'],
    monogram: 'WP',
  },
  {
    id: 'vinted',
    name: 'Vinted',
    categories: ['shopping'],
    domains: [
      'vinted.es',
      'www.vinted.es',
      'vinted.com',
      'www.vinted.com',
      'vinted.fr',
      'www.vinted.fr',
    ],
    aliases: ['vinted', 'binted', 'vintet'],
    monogram: 'VI',
  },
];
