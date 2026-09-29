/**
 * The mini timer window (PROMPT §5, §10 «Mini temporizador»): 180×44 DIP, frameless, always on
 * top, dragged by its whole body (`-webkit-app-region: drag`; main keeps where it is dropped).
 * The icon of what is blocked, the time at 20 px (600, `tabular-nums`, the guardian's `endsAt`,
 * ticking only while visible) and, with Study Mode, the camera dot. No controls: the footer's
 * «Mini temporizador», the tray checkbox and the global shortcut show and hide it.
 *
 * The window is transparent (PLATFORM): the rounded 8 px box with the theme background is
 * drawn here. Screen readers get a landmark named «Mini temporizador», what the countdown
 * belongs to, and the `role="timer"` label («Quedan 42 minutos»); it never speaks on its own
 * (the main window's countdown does).
 */
import type { LucideIcon } from 'lucide-react';
import { GraduationCap, Lock, LockOpen, ShieldAlert, ShieldOff } from 'lucide-react';
import { useMemo } from 'react';
import { Countdown, Icon, ServiceIcon, StatusDot } from '../../components';
import { useClockNow } from '../../hooks/useNow';
import { useSnapshot } from '../../store/context';
import { MINI_TIMER } from './i18n';
import { deriveMiniTimerView, type MiniTimerGlyph, type MiniTimerView } from './view';
import './mini-timer.css';

const GLYPHS: Readonly<Record<MiniTimerGlyph, LucideIcon>> = {
  lock: Lock,
  exam: GraduationCap,
  punishment: ShieldAlert,
  idle: LockOpen,
  down: ShieldOff,
};

function glyphTone(glyph: MiniTimerGlyph): 'red' | 'muted' | undefined {
  if (glyph === 'punishment' || glyph === 'down') return 'red';
  if (glyph === 'idle') return 'muted';
  return undefined;
}

function TimerIcon(props: { icon: MiniTimerView['icon'] }): React.JSX.Element {
  const { icon } = props;
  if (icon.kind === 'service') {
    return (
      <span className="mt-icon">
        <ServiceIcon className="mt-monogram" monogram={icon.monogram} favicon={icon.favicon} />
      </span>
    );
  }
  return (
    <span className="mt-icon" data-tone={glyphTone(icon.glyph)}>
      <Icon icon={GLYPHS[icon.glyph]} size="tile" />
    </span>
  );
}

export default function MiniTimerWindow(): React.JSX.Element {
  const snapshot = useSnapshot();
  const now = useClockNow();
  const view = useMemo(() => deriveMiniTimerView(snapshot, now), [snapshot, now]);

  return (
    <main className="mt" aria-labelledby="mt-title" data-kind={view.kind}>
      <h1 id="mt-title" className="sr-only">
        {MINI_TIMER.title}
      </h1>
      <TimerIcon icon={view.icon} />
      {view.label ? <span className="sr-only">{view.label}</span> : null}
      {view.endsAt ? (
        <Countdown endsAt={view.endsAt} size="row" announce={false} className="mt-countdown" />
      ) : (
        <span className="mt-text" data-tone={view.textTone ?? undefined} data-fit="">
          {view.text}
        </span>
      )}
      <span className="mt-camera">
        {view.camera ? (
          <>
            <StatusDot tone="red" />
            <span className="sr-only">{MINI_TIMER.camera}</span>
          </>
        ) : null}
      </span>
    </main>
  );
}
