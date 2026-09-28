/**
 * `ui:command confirm-template` (tray «Bloqueo rápido ▸») and `confirm-draft` (Bloqueos
 * «Bloquear…»), pure. They go through section 2's own guarded transitions (`openTemplate`,
 * `openDraft`), so they follow the idempotency rule of `sections/bloqueo/reducer.ts`:
 * - while a create is sending («Bloqueando…») or got no answer (frozen «El guardián no responde
 *   · Reintentar»: it may have landed), nothing changes; the shell only focuses that card, so a
 *   second create with a new key can never start behind it;
 * - a create the guardian rejected created nothing: the new card replaces it and the old
 *   intent is dismissed (`block:create-dismiss`), also when no card showed it any more.
 */
import type { UiCommand } from '../../../shared/ipc';
import type { IntentId, MainLocalState, UiSnapshot } from '../../../shared/ui-state';
import {
  cardCreateState,
  openDraft,
  openTemplate,
  type Transition,
} from '../sections/bloqueo/reducer';

export type ConfirmCommand = Extract<UiCommand, { type: 'confirm-template' | 'confirm-draft' }>;

export interface ConfirmCommandResult extends Transition {
  /** A new card opened (else the current state stays and only gets the focus). */
  opened: boolean;
}

export function confirmCommand(
  command: ConfirmCommand,
  snapshot: UiSnapshot,
  main: MainLocalState,
  newIntentId: () => IntentId,
): ConfirmCommandResult {
  const t =
    command.type === 'confirm-template'
      ? openTemplate(snapshot, main, command.templateId, newIntentId, 'tray')
      : openDraft(snapshot, main, command.draft, newIntentId);
  const card = t.main.card;
  if (t.main === main || !card || card === main.card) return { ...t, opened: false };
  // A rejected create that no card shows any more is superseded too (it created nothing).
  const create = snapshot.ops.create;
  const orphan =
    main.card === null && create && cardCreateState(snapshot, null) === 'rejected'
      ? create.intentId
      : null;
  return {
    main: { ...t.main, armed: null },
    dismissIntentId: t.dismissIntentId ?? orphan,
    focus: 'confirm',
    opened: true,
  };
}
