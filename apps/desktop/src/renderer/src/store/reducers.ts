/**
 * Pure transitions of the renderer store (docs/DESKTOP.md §7.1), kept apart so vitest covers
 * them without React or a DOM:
 * - a snapshot is applied only when its `rev` is newer, together with `reconcileMainLocal`, so
 *   the card whose create the guardian just confirmed closes in the same render;
 * - a harness load replaces both renderer-local parts;
 * - `ui:detail` retargets the one detail window and seeds its view.
 * `ui:command`'s confirmation cards go through section 2's guarded transitions
 * (`app/commands.ts`).
 */
import type { HarnessLoad, InitPayload } from '../../../shared/ipc';
import {
  draftFromSeed,
  initialDetailLocal,
  initialMainLocal,
  reconcileMainLocal,
  type DetailLocalState,
  type DetailRequest,
  type UiSnapshot,
  type UiState,
} from '../../../shared/ui-state';

/** First `UiState` of a window, from `app:init`. */
export function initialUiState(init: InitPayload): UiState {
  return {
    env: {
      window: init.window,
      platform: init.platform,
      layout: init.layout,
      detail: init.detail,
      visible: init.visible,
    },
    snapshot: init.snapshot,
    main: init.harness?.main ?? initialMainLocal(),
    detail: init.harness?.detail ?? initialDetailLocal(init.snapshot.prefs),
  };
}

/**
 * Next `{snapshot, main}` for a pushed snapshot, or `null` when it must be ignored (its `rev`
 * is not newer than the one shown).
 */
export function applySnapshotTo(
  current: Pick<UiState, 'snapshot' | 'main'>,
  snapshot: UiSnapshot,
): Pick<UiState, 'snapshot' | 'main'> | null {
  if (snapshot.rev <= current.snapshot.rev) return null;
  return { snapshot, main: reconcileMainLocal(snapshot, current.main) };
}

/** Renderer-local state after a harness load (`ui:harness`): the fixture's, as is. */
export function applyHarnessLoad(load: HarnessLoad): Pick<UiState, 'main' | 'detail'> {
  return { main: load.main, detail: load.detail };
}

/**
 * The detail window's local state when main retargets it (`ui:detail`): Bloqueos takes the
 * seed («con lo que sí entendió»), Emergencia the blocks, Ajustes the group to scroll to. Help
 * and the armed «¿Seguro?» never carry over from another view, except with `keepTransient`:
 * the retarget that follows a harness load belongs to that fixture, whose armed «¿Seguro?» and
 * help must survive it. Idempotent.
 */
export function detailForRequest(
  detail: DetailLocalState,
  request: DetailRequest,
  snapshot: UiSnapshot,
  keepTransient = false,
): DetailLocalState {
  const base: DetailLocalState = keepTransient ? detail : { ...detail, armed: null, help: null };
  switch (request.name) {
    case 'bloqueos':
      if (!request.seed) return base;
      return {
        ...base,
        bloqueos: {
          ...base.bloqueos,
          form: draftFromSeed(request.seed, snapshot.prefs),
          seedPhrase: request.seed.phrase,
        },
      };
    case 'emergencia':
      return { ...base, emergencia: { ...base.emergencia, blockIds: request.blockIds } };
    case 'ajustes':
      return { ...base, ajustes: { ...base.ajustes, group: request.group } };
    case 'estadisticas':
      return request.range
        ? { ...base, estadisticas: { ...base.estadisticas, range: request.range } }
        : base;
    case 'recompensas':
    case 'logros':
      return base;
  }
}
