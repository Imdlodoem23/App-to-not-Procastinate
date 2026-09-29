/**
 * The Nuclear overlay (PROMPT §10 «Nuclear»): one full-screen window per display (PLATFORM),
 * the theme background, and in the middle the app's 440 px column: the section header
 * «Castigo · vuelves a las 18:40», the countdown at 72 px, the cause and its cost as data, and
 * a single secondary «Salida de emergencia» with its help line. No animation, no colour
 * beyond the tokens' meanings, nothing that scolds.
 *
 * «Salida de emergencia» is an in-place «¿Seguro?» (the price on the help line, red outline);
 * the second press within 3 s sends `nuclear:emergency-exit` and main opens Emergencia above
 * the overlay, where the phrase and the wait apply. With an emergency already requested it
 * opens it directly. The overlay is focusable and takes the focus when it appears (PLATFORM);
 * the renderer then puts the DOM focus on the column (a named, non-tabbable group: the heading
 * names it, the countdown and the cause describe it), so a screen reader lands on the countdown,
 * and Tab goes on to «Salida de emergencia» (also offered in the tray). It never takes the focus
 * away from a focused element. The countdown keeps its `role="timer"` label and says «Castigo
 * terminado» at the end.
 */
import { DoorOpen, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { SHARED } from '../../../../shared/i18n';
import { Countdown, InPlaceConfirm, Section, Tile, TileRow, type HelpTone } from '../../components';
import type { CountdownAnnounce } from '../../components/Countdown';
import { useBridge, useSnapshot, useVisible } from '../../store/context';
import { NUCLEAR } from './i18n';
import { NUCLEAR_EXIT_ARM_ID, deriveNuclearView, type NuclearExit } from './view';
import './nuclear.css';

const ANNOUNCE: Exclude<CountdownAnnounce, false> = {
  mark: (minutes: number): string => SHARED.remaining.announce(minutes),
  get end(): string {
    return NUCLEAR.ended;
  },
};

function exitHelp(exit: NuclearExit): { help: React.ReactNode; tone: HelpTone } {
  switch (exit.kind) {
    case 'arm':
      return { help: exit.help, tone: 'muted' };
    case 'counting':
      return {
        help: (
          <span className="nuc-emergency">
            {exit.help}
            <Countdown endsAt={exit.readyAt} size="row" announce={false} />
          </span>
        ),
        tone: 'orange',
      };
    case 'ready':
      return { help: exit.help, tone: 'orange' };
  }
}

export default function NuclearWindow(): React.JSX.Element {
  const snapshot = useSnapshot();
  const bridge = useBridge();
  const view = useMemo(() => deriveNuclearView(snapshot), [snapshot]);
  const openEmergency = (): void => bridge.send('nuclear:emergency-exit', null);
  const { help, tone } = exitHelp(view.exit);
  const visible = useVisible();
  const column = useRef<HTMLDivElement>(null);

  // On mount, when the punishment starts and when the overlay is shown again: land on the
  // column, unless something (the exit) already holds the focus.
  useEffect(() => {
    if (!view.active || !visible) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== document.documentElement) return;
    column.current?.focus({ preventScroll: true });
  }, [view.active, visible]);

  return (
    <main className="nuc" aria-labelledby="nuc-app-title">
      <h1 id="nuc-app-title" className="sr-only">
        {NUCLEAR.appTitle}
      </h1>
      {view.active ? (
        <div
          ref={column}
          className="nuc-column"
          role="group"
          tabIndex={-1}
          aria-labelledby="nuclear-title"
          aria-describedby={view.cause || view.points ? 'nuc-timer nuc-cause' : 'nuc-timer'}
        >
          <Section id="nuclear" icon={ShieldAlert} title={view.title}>
            {view.endsAt ? (
              <div id="nuc-timer">
                <Countdown
                  endsAt={view.endsAt}
                  size="big"
                  announce={ANNOUNCE}
                  className="nuc-countdown"
                />
              </div>
            ) : null}
            {view.cause || view.points ? (
              <p id="nuc-cause" className="nuc-cause">
                {view.cause ? <span>{view.cause}</span> : null}
                {view.cause && view.points ? (
                  <span className="nuc-separator" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                {view.points ? <span className="nuc-points">{view.points}</span> : null}
              </p>
            ) : null}
          </Section>
          <TileRow
            id="nuclear-exit"
            label={NUCLEAR.exit.rowLabel}
            columns={3}
            className="nuc-exit"
            help={help}
            helpTone={tone}
            helpLive="polite"
          >
            {view.exit.kind === 'arm' ? (
              <InPlaceConfirm
                armId={NUCLEAR_EXIT_ARM_ID}
                id="exit"
                label={NUCLEAR.exit.label}
                mnemonic={NUCLEAR.keys.exit}
                icon={DoorOpen}
                size="text"
                secondary
                help={view.exit.help}
                consequence={view.exit.consequence}
                onConfirm={openEmergency}
              />
            ) : (
              <Tile
                id="exit"
                label={NUCLEAR.exit.label}
                mnemonic={NUCLEAR.keys.exit}
                icon={DoorOpen}
                size="text"
                secondary
                onPress={openEmergency}
              />
            )}
          </TileRow>
        </div>
      ) : null}
    </main>
  );
}
