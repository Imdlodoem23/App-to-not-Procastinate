/**
 * Local natural-language parser for the «¿Qué quieres hacer?» field: services, categories
 * and domains to block, durations and end times, and study intents. Pure and offline. It
 * reads Spanish and English phrases (even mixed) whatever the UI language; its chip labels
 * and helpers (`durationLabel`, `untilLabel`, `notUnderstoodMessage`) come in Spanish (the
 * default) or English. Import it as `@centrate/shared/parser`. Code lives in ./parser/.
 */
export * from './parser/index';
