/**
 * The countdown (PROMPT §10 «Cuenta atrás»): `endsAt − now` from the guardian's `endsAt` (it
 * already corrects clock changes), re-rendered by a single `setTimeout` aligned to the displayed
 * second and re-armed after every render; never a decremented counter, never rAF. `M:SS` under
 * an hour, `H:MM:SS` above, 600 weight, `tabular-nums`, −0.02em, seconds at 60 % (big size
 * only: small text needs full contrast), no digit animation, and the last minute does not
 * turn red.
 *
 * Screen readers: `role="timer"` with «Quedan 43 minutos», and a separate `aria-live="polite"`
 * region that speaks only at 15, 5 and 1 min and at the end.
 *
 * Timers run only while the window is visible; with the harness's frozen clock it shows that
 * instant and does not tick.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/context';
import { useClockNow, useTick } from '../hooks/useNow';
import { countdownModel, countdownSpeech } from './countdown-model';

export function Countdown(props: {
  endsAt: string | number;
  /** `big`: 48 px (40 in compact density). `row`: 13 px, for the 28 px rows. */
  size?: 'big' | 'row';
  className?: string;
}): React.JSX.Element {
  const { endsAt, size = 'big' } = props;
  const visible = useAppStore((s) => s.env.visible);
  const frozen = useAppStore((s) => s.snapshot.harness?.frozenNowMs ?? null);
  const now = useClockNow();
  const tick = useTick();
  const model = countdownModel(endsAt, now);
  const prev = useRef<number | null>(null);
  const [speech, setSpeech] = useState('');

  useEffect(() => {
    const said = countdownSpeech(prev.current, model.remainingMs);
    prev.current = model.remainingMs;
    if (said) setSpeech(said);
  }, [model.remainingMs]);

  useEffect(() => {
    if (!visible || frozen !== null || model.nextDelayMs === null) return undefined;
    const timer = setTimeout(tick, model.nextDelayMs);
    return () => clearTimeout(timer);
  });

  return (
    <div
      className={props.className ? `c-countdown ${props.className}` : 'c-countdown'}
      data-size={size}
    >
      <span role="timer" aria-label={model.aria} className="c-countdown-digits" data-fit="">
        {model.parts.lead}
        <span className="c-countdown-seconds">{model.parts.seconds}</span>
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {speech}
      </span>
    </div>
  );
}
