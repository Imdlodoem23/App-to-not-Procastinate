import type { Service } from '../types';

/*
 * Opt-in services: they have no category, so they are only blocked when the user names
 * them («no LinkedIn en una hora»). Categories and punishments never touch them because
 * each one is regularly used to study, work or relax while studying:
 * - LinkedIn: jobs and LinkedIn Learning.
 * - Vimeo: many courses host their videos there.
 * - Chess.com and Lichess: chess is taught and trained as a learning activity.
 * - Spotify: plenty of people study with music.
 * - RTVE Play: shares www.rtve.es with public news and educational programmes (the hosts
 *   file cannot block the /play/ path alone).
 */
export const OPT_IN_SERVICES: readonly Service[] = [
  {
    id: 'linkedin',
    name: 'LinkedIn',
    categories: [],
    domains: [
      'linkedin.com',
      'www.linkedin.com',
      'es.linkedin.com',
      'lnkd.in',
      'licdn.com',
      'static.licdn.com',
      'media.licdn.com',
    ],
    aliases: ['linkedin', 'linked in', 'linkedln', 'linkdin', 'linkedim'],
    monogram: 'in',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    categories: [],
    domains: [
      'vimeo.com',
      'www.vimeo.com',
      'player.vimeo.com',
      'vimeocdn.com',
      'f.vimeocdn.com',
      'i.vimeocdn.com',
    ],
    aliases: ['vimeo', 'vimeo.com'],
    monogram: 'V',
  },
  {
    id: 'chess-com',
    name: 'Chess.com',
    categories: [],
    domains: ['chess.com', 'www.chess.com', 'chesscomfiles.com', 'images.chesscomfiles.com'],
    aliases: ['chess.com', 'chess', 'chesscom', 'ajedrez'],
    monogram: 'CH',
  },
  {
    id: 'lichess',
    name: 'Lichess',
    categories: [],
    domains: ['lichess.org', 'lichess1.org'],
    aliases: ['lichess', 'lichess.org', 'li chess'],
    monogram: 'LI',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    categories: [],
    domains: [
      'spotify.com',
      'www.spotify.com',
      'open.spotify.com',
      'accounts.spotify.com',
      'apresolve.spotify.com',
      'spclient.wg.spotify.com',
      'spoti.fi',
      'scdn.co',
      'i.scdn.co',
      'open.scdn.co',
    ],
    appIds: ['spotify'],
    aliases: ['spotify', 'spoti', 'spotifai', 'espotify', 'spotfy'],
    monogram: 'SY',
  },
  {
    id: 'rtve-play',
    name: 'RTVE Play',
    categories: [],
    domains: ['rtve.es', 'www.rtve.es'],
    aliases: ['rtve', 'rtve play', 'rtveplay', 'tve'],
    monogram: 'RT',
  },
];
