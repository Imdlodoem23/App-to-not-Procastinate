/**
 * «Reparar» (section 1, the footer, BLOQUEO's «El guardián no responde · Reintentar · Reparar»
 * and Ajustes): `guardian:repair` starts, or installs and starts, the guardian with elevation.
 * Local to the component that shows it: the label reads «Reparando…» meanwhile (no spinner) and
 * the outcome becomes one line of help. The warning itself disappears on the next good poll.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RENDERER_ES } from '../i18n/es';
import { errorCopy } from '../i18n/errors';
import { useBridge } from '../store/context';

export interface RepairApi {
  running: boolean;
  /** Outcome line for the help line (`null` until a run ends). */
  message: { text: string; tone: 'muted' | 'red' } | null;
  run(): void;
}

export function useRepair(): RepairApi {
  const bridge = useBridge();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<RepairApi['message']>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (running) return;
    setRunning(true);
    setMessage(null);
    void bridge.invoke('guardian:repair', null).then(
      (result) => {
        if (!mounted.current) return;
        setRunning(false);
        if (!result.ok) {
          setMessage({ text: errorCopy(result.error).text, tone: 'red' });
          return;
        }
        const text = RENDERER_ES.repair[result.value.outcome];
        setMessage({ text, tone: result.value.outcome === 'started' ? 'muted' : 'red' });
      },
      () => {
        if (!mounted.current) return;
        setRunning(false);
        setMessage({ text: RENDERER_ES.errors.generic, tone: 'red' });
      },
    );
  }, [bridge, running]);

  return { running, message, run };
}
