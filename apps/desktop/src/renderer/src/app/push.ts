/**
 * Main → renderer pushes (docs/DESKTOP.md §4.3, §7.2). Subscribed before `app:init` and buffered,
 * so nothing pushed while the init is in flight is lost; replayed in order once the store
 * exists.
 *
 * - `ui:snapshot`: replace the snapshot (newer `rev` only).
 * - `ui:layout`: new height budget (the main window re-measures).
 * - `ui:visibility`: timers run only while visible; hiding disarms any «¿Seguro?»; a show with
 *   `focusField` focuses «¿Qué quieres hacer?» synchronously.
 * - `ui:prepare-show`: render the latest state synchronously (`flushSync`), measure and answer
 *   `window:show-ack` before main shows the window (≤ 50 ms).
 * - `ui:detail`: retarget the detail window (a fixture's own retarget, right after its
 *   `ui:harness`, keeps the fixture's armed «¿Seguro?» and help).
 * - `ui:command`: focus the field, or open the confirmation card from a template or a draft
 *   through section 2's guarded transitions (`commands.ts`): never over «Bloqueando…» or an
 *   unanswered create, which only get the focus.
 * - `ui:harness`: replace the renderer-local state with a fixture's.
 */
import { flushSync } from 'react-dom';
import type { StoreApi } from 'zustand/vanilla';
import {
  PUSH_CHANNELS,
  type CentrateBridge,
  type PushChannel,
  type PushPayload,
} from '../../../shared/ipc';
import type { IntentId } from '../../../shared/ui-state';
import { detailForRequest } from '../store/reducers';
import type { AppStore } from '../store/store';
import { confirmCommand } from './commands';
import type { WindowServices } from './window-services';

export type PushHandlers = { [C in PushChannel]: (payload: PushPayload<C>) => void };

export interface PushBuffer {
  /** Start delivering (queued pushes first, in order). */
  attach(handlers: PushHandlers): void;
  dispose(): void;
}

export function bufferPushes(bridge: CentrateBridge): PushBuffer {
  let handlers: PushHandlers | null = null;
  const queue: { channel: PushChannel; payload: unknown }[] = [];
  const deliver = (channel: PushChannel, payload: unknown): void => {
    (handlers?.[channel] as ((p: unknown) => void) | undefined)?.(payload);
  };
  const unsubscribes = PUSH_CHANNELS.map((channel) =>
    bridge.on(channel, (payload: unknown) => {
      if (handlers) deliver(channel, payload);
      else queue.push({ channel, payload });
    }),
  );
  return {
    attach(next) {
      handlers = next;
      for (const item of queue.splice(0)) deliver(item.channel, item.payload);
    },
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      handlers = null;
    },
  };
}

/**
 * A new id per confirmation card (sent as the guardian's `Idempotency-Key`): a UUID, or 32
 * hex digits, both within `isIntentId`.
 */
export function newIntentId(): IntentId {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPushHandlers(
  store: StoreApi<AppStore>,
  services: WindowServices,
): PushHandlers {
  const state = (): AppStore => store.getState();
  /** The detail local state a harness load set, until a retarget or a change replaces it. */
  let fixtureDetail: AppStore['detail'] | null = null;
  return {
    'ui:snapshot': (snapshot) => state().applySnapshot(snapshot),

    'ui:layout': (layout) => state().setEnv({ layout }),

    'ui:visibility': ({ visible, focusField }) => {
      flushSync(() => {
        state().setEnv({ visible });
        state().touchClock();
        if (!visible) state().setArmed(null);
      });
      if (visible && focusField) services.focusField();
    },

    'ui:prepare-show': ({ seq, layout }) => {
      flushSync(() => {
        state().setEnv({ layout });
        state().touchClock();
      });
      const report = services.measure();
      if (report) state().bridge.send('window:show-ack', { seq, layout: report });
    },

    'ui:detail': (request) => {
      const s = state();
      const fromFixture = fixtureDetail !== null && s.detail === fixtureDetail;
      fixtureDetail = null;
      s.setEnv({ detail: request });
      s.updateDetail((detail) => detailForRequest(detail, request, s.snapshot, fromFixture));
    },

    'ui:command': (command) => {
      if (command.type === 'focus-field') {
        services.focusField();
        return;
      }
      // The footer shows it on its help line (`sections/footer/Footer.tsx`).
      if (command.type === 'keep-awake-failed') return;
      const s = state();
      const result = confirmCommand(command, s.snapshot, s.main, newIntentId);
      if (result.opened) flushSync(() => s.updateMain(() => result.main));
      if (result.dismissIntentId) {
        s.bridge.send('block:create-dismiss', { intentId: result.dismissIntentId });
      }
      // The new card's button, or the card that stays («Bloqueando…», «Reintentar»).
      if (!services.focus('confirm')) services.focusField();
    },

    'ui:harness': (load) => {
      flushSync(() => state().loadHarness(load));
      fixtureDetail = state().detail;
    },
  };
}
