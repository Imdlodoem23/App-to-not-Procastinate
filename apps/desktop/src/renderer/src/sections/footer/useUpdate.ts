/**
 * «Actualizar a vX» in the footer (PROMPT §10 «Pie», §12): `updater:download` fetches the new
 * version (PLATFORM opens the download page instead on a check-only system) and, once it is
 * `ready`, `updater:install` restarts into it. Progress travels in `snapshot.updater`, so the
 * link turns into «Descargando v0.2.0 · 45 %» on its own; this hook only guards against a
 * second press while the call runs and turns the answer into one line for the footer's help
 * line, like «Reparar» (no spinner).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorCopy } from '../../i18n/errors';
import { RENDERER } from '../../i18n/messages';
import { useBridge } from '../../store/context';
import { updateOutcome, type FooterUpdateAction, type UpdateMessage } from './view';

export interface UpdateApi {
  running: boolean;
  /** Outcome for the help line (`null` until a press answered something worth saying). */
  message: UpdateMessage | null;
  run(action: FooterUpdateAction): void;
}

export function useUpdate(): UpdateApi {
  const bridge = useBridge();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<UpdateMessage | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (action: FooterUpdateAction) => {
      if (running) return;
      setRunning(true);
      setMessage(null);
      const channel = action === 'install' ? 'updater:install' : 'updater:download';
      void bridge.invoke(channel, null).then(
        (result) => {
          if (!mounted.current) return;
          setRunning(false);
          setMessage(
            result.ok
              ? updateOutcome(action, result.value)
              : { text: errorCopy(result.error).text, tone: 'red' },
          );
        },
        () => {
          if (!mounted.current) return;
          setRunning(false);
          setMessage({ text: RENDERER.errors.generic, tone: 'red' });
        },
      );
    },
    [bridge, running],
  );

  return { running, message, run };
}
