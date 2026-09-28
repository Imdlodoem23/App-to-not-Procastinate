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
 * - `ui:detail`: retarget the detail window.
 * - `ui:command`: focus the field, or open the confirmation card from a template or a draft.
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
import { isIntentId } from '../../../shared/ui-state';
import { cardForCommand, detailForRequest, mainWithCard } from '../store/reducers';
import type { AppStore } from '../store/store';
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

/** A new id per confirmation card (sent as the guardian's `Idempotency-Key`). */
export function newIntentId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPushHandlers(
  store: StoreApi<AppStore>,
  services: WindowServices,
): PushHandlers {
  const state = (): AppStore => store.getState();
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
      s.setEnv({ detail: request });
      s.updateDetail((detail) => detailForRequest(detail, request, s.snapshot));
    },

    'ui:command': (command) => {
      if (command.type === 'focus-field') {
        services.focusField();
        return;
      }
      const intentId = newIntentId();
      const card = isIntentId(intentId)
        ? cardForCommand(command, state().snapshot, intentId)
        : null;
      if (!card) return;
      flushSync(() => state().updateMain((main) => mainWithCard(main, card)));
      services.focus('confirm');
    },

    'ui:harness': (load) => {
      flushSync(() => state().loadHarness(load));
    },
  };
}
