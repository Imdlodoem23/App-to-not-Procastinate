import type { Service } from '../types';

/*
 * News and sports.
 * - General newspapers (El País, El Mundo, 20minutos, ABC, La Vanguardia, elDiario.es,
 *   El Confidencial) are included: this category is only blocked when the user picks it
 *   or by the level-1 punishment, and scrolling news is a classic way to procrastinate.
 * - Xataka (tech news blog network) is included for the same reason.
 * - RTVE lives in opt-in.ts (public service news and educational content share its host).
 * - Unidad Editorial's CDN (uecdn.es) is shared by Marca, El Mundo and Expansión: not
 *   listed.
 */
export const NEWS_SERVICES: readonly Service[] = [
  {
    id: 'marca',
    name: 'Marca',
    categories: ['news'],
    domains: ['marca.com', 'www.marca.com'],
    aliases: ['marca', 'marca.com', 'diario marca'],
    monogram: 'MA',
  },
  {
    id: 'as',
    name: 'AS',
    categories: ['news'],
    domains: ['as.com', 'www.as.com', 'resultados.as.com'],
    aliases: ['as', 'as.com', 'diario as'],
    monogram: 'AS',
  },
  {
    id: 'mundo-deportivo',
    name: 'Mundo Deportivo',
    categories: ['news'],
    domains: ['mundodeportivo.com', 'www.mundodeportivo.com'],
    aliases: ['mundo deportivo', 'mundodeportivo', 'el mundo deportivo'],
    monogram: 'MD',
  },
  {
    id: 'sport',
    name: 'Sport',
    categories: ['news'],
    domains: ['sport.es', 'www.sport.es'],
    aliases: ['sport', 'diario sport', 'sport.es'],
    monogram: 'SP',
  },
  {
    id: 'relevo',
    name: 'Relevo',
    categories: ['news'],
    domains: ['relevo.com', 'www.relevo.com'],
    aliases: ['relevo'],
    monogram: 'RL',
  },
  {
    id: 'espn',
    name: 'ESPN',
    categories: ['news'],
    domains: [
      'espn.com',
      'www.espn.com',
      'espn.com.mx',
      'www.espn.com.mx',
      'espn.go.com',
      'espndeportes.espn.com',
      'espncdn.com',
      'a.espncdn.com',
    ],
    aliases: ['espn', 'espn deportes'],
    monogram: 'ES',
  },
  {
    id: 'transfermarkt',
    name: 'Transfermarkt',
    categories: ['news'],
    domains: [
      'transfermarkt.es',
      'www.transfermarkt.es',
      'transfermarkt.com',
      'www.transfermarkt.com',
    ],
    aliases: ['transfermarkt', 'transfer market', 'transfermark'],
    monogram: 'TM',
  },
  {
    id: 'el-pais',
    name: 'El País',
    categories: ['news'],
    domains: ['elpais.com', 'www.elpais.com'],
    aliases: ['el pais', 'el país', 'elpais', 'diario el pais'],
    monogram: 'EP',
  },
  {
    id: 'el-mundo',
    name: 'El Mundo',
    categories: ['news'],
    domains: ['elmundo.es', 'www.elmundo.es'],
    aliases: ['el mundo', 'elmundo', 'diario el mundo'],
    monogram: 'EM',
  },
  {
    id: '20minutos',
    name: '20minutos',
    categories: ['news'],
    domains: ['20minutos.es', 'www.20minutos.es'],
    aliases: ['20minutos', '20 minutos', 'veinte minutos'],
    monogram: '20',
  },
  {
    id: 'abc',
    name: 'ABC',
    categories: ['news'],
    domains: ['abc.es', 'www.abc.es'],
    aliases: ['abc', 'abc.es', 'diario abc'],
    monogram: 'AB',
  },
  {
    id: 'la-vanguardia',
    name: 'La Vanguardia',
    categories: ['news'],
    domains: ['lavanguardia.com', 'www.lavanguardia.com'],
    aliases: ['la vanguardia', 'lavanguardia', 'vanguardia'],
    monogram: 'LV',
  },
  {
    id: 'eldiario-es',
    name: 'elDiario.es',
    categories: ['news'],
    domains: ['eldiario.es', 'www.eldiario.es'],
    aliases: ['eldiario', 'eldiario.es', 'el diario.es'],
    monogram: 'ED',
  },
  {
    id: 'el-confidencial',
    name: 'El Confidencial',
    categories: ['news'],
    domains: ['elconfidencial.com', 'www.elconfidencial.com'],
    aliases: ['el confidencial', 'elconfidencial'],
    monogram: 'EC',
  },
  {
    id: 'xataka',
    name: 'Xataka',
    categories: ['news'],
    domains: [
      'xataka.com',
      'www.xataka.com',
      'xatakamovil.com',
      'www.xatakamovil.com',
      'xatakandroid.com',
      'www.xatakandroid.com',
    ],
    aliases: ['xataka', 'xataca', 'chataka'],
    monogram: 'XA',
  },
  {
    id: 'meneame',
    name: 'Menéame',
    categories: ['news'],
    domains: ['meneame.net', 'www.meneame.net'],
    aliases: ['meneame', 'menéame'],
    monogram: 'MN',
  },
];
