/**
 * The Pomodoro (PROMPT §9: 25/5, 50/10 and the user's own; breaks pause camera watching). Pure
 * logic in `timer.ts` for the Study Mode wave (tiles, meter, camera watcher) plus the hook that
 * ticks it. There is no `MainWindowFeature` here: while the `study` flag is off no session runs,
 * so there is nothing for a main-window clock to do.
 */
export * from './timer';
export { usePomodoro } from './usePomodoro';
export { POMODORO, POMODORO_EN, POMODORO_ES, type PomodoroMessages } from './i18n';
