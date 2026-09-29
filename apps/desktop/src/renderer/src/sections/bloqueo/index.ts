/**
 * Section 2 «Bloqueo» (BLOQUEO, docs/DESKTOP.md §3.2): `MainWindow` renders `BloqueoSection`
 * (no props). The ids let the shell find the field and the section root; the pure view model
 * and transitions are exported for tests and other owners.
 */
export { BloqueoSection } from './BloqueoSection';
export { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, BLOQUEO_SECTION_ID, deriveBloqueoView } from './view';
export type { BloqueoView } from './view';
export { enterBloqueo, escapeBloqueo, openDraft, openTemplate } from './reducer';
export { fieldEnter, cardForTemplate, draftFromRequest } from './draft';
