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
 * opens it directly. The overlay never takes focus (PLATFORM), so it is driven by the pointer;
 * the countdown keeps its `role="timer"` label and says «Castigo terminado» at the end.
 */
import { DoorOpen, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { SHARED } from '../../../../shared/i18n';
import { Countdown, InPlaceConfirm, Section, Tile, TileRow, type HelpTone } from '../../components';
import type { CountdownAnnounce } from '../../components/Countdown';
import { useBridge, useSnapshot } from '../../store/context';
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

  return (
    <main className="nuc" aria-labelledby="nuc-app-title">
      <h1 id="nuc-app-title" className="sr-only">
        {NUCLEAR.appTitle}
      </h1>
      {view.active ? (
        <div className="nuc-column">
          <Section id="nuclear" icon={ShieldAlert} title={view.title}>
            {view.endsAt ? (
              <Countdown
                endsAt={view.endsAt}
                size="big"
                announce={ANNOUNCE}
                className="nuc-countdown"
              />
            ) : null}
            {view.cause || view.points ? (
              <p className="nuc-cause">
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
