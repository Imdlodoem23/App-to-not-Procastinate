/**
 * The onboarding (PROMPT §9 «Onboarding», §10 «Onboarding»; docs/DESKTOP.md §15.2): default
 * export, no props. The main window shows it in place of its sections while
 * `onboardingActive(snapshot)`, centred on the screen; the footer stays.
 *
 * One section per step, like the rest of the window: «Guardián · paso 2 de 5» · «No instalado»,
 * one sentence, what the step needs (the pairing code at 32 px, «¿Qué quieres hacer?» with the
 * first block typed), a row «Instalar | Omitir» with its help line and the progress dots. No
 * «Atrás» (PROMPT §10 forbids back navigation): every step can be skipped and Ajustes repeats
 * them.
 *
 * Showing the window puts the focus on the step's first action (or the field in step 5), through
 * the same `field` focus target section 2 uses.
 */
import { Camera, Lock, Puzzle, ShieldCheck, Sprout, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { Countdown, Field, Section, TextButton, Tile, TileRow } from '../../components';
import { useFocusTarget } from '../../app/services';
import type { OnboardingStep } from '../../../../shared/prefs';
import { ONBOARDING } from './i18n';
import { useOnboarding } from './useOnboarding';
import type { OnboardingView } from './view';
import './onboarding.css';

const O = ONBOARDING;

const ICONS: Readonly<Record<OnboardingStep, LucideIcon>> = {
  welcome: Sprout,
  guardian: ShieldCheck,
  extension: Puzzle,
  camera: Camera,
  'first-block': Lock,
};

const ROW_ID = 'onboarding-actions';

function PairingCode(props: {
  pairing: NonNullable<OnboardingView['pairing']>;
  onNewCode(): void;
}): React.JSX.Element {
  const { pairing } = props;
  if (pairing.kind === 'none') {
    return (
      <p className="ob-meta">
        {pairing.expired ? <span>{O.pairing.expired}</span> : null}
        <TextButton tone="blue" onPress={props.onNewCode}>
          {O.pairing.newCode}
        </TextButton>
      </p>
    );
  }
  return (
    <div className="ob-pairing">
      <p className="ob-code" data-selectable="">
        <span aria-hidden="true">{pairing.code}</span>
        <span className="sr-only">{O.pairing.codeLabel(pairing.code.split('').join(' '))}</span>
      </p>
      <p className="ob-meta">
        <span>{O.pairing.expires}</span>
        <Countdown endsAt={pairing.expiresAtMs} size="row" />
        {pairing.port ? <span>· {pairing.port}</span> : null}
      </p>
    </div>
  );
}

export default function Onboarding(): React.JSX.Element {
  const api = useOnboarding();
  const { view } = api;
  const field = useRef<HTMLInputElement>(null);
  const actions = useRef<HTMLDivElement>(null);

  // Show, Ctrl+N and `/` focus the step's field (step 5) or its first enabled action.
  useFocusTarget('field', () => {
    if (view.field && field.current) {
      field.current.focus({ preventScroll: true });
      return true;
    }
    const first = [
      ...(actions.current?.querySelectorAll<HTMLElement>(`[data-row-tile="${ROW_ID}"]`) ?? []),
    ].find((t) => t.getAttribute('aria-disabled') !== 'true');
    if (!first) return false;
    first.focus({ preventScroll: true });
    return true;
  });

  return (
    <div className="ob" data-step={view.step} ref={actions}>
      <Section
        id="onboarding"
        icon={ICONS[view.step]}
        title={view.title}
        datum={view.status}
        datumTone={view.statusTone}
      >
        <p className="ob-sentence">{view.sentence}</p>
        {view.pairing ? (
          <PairingCode pairing={view.pairing} onNewCode={api.newPairingCode} />
        ) : null}
        {view.field ? (
          <Field
            ref={field}
            value={api.composerText}
            onChange={api.setComposerText}
            label={O.fieldLabel}
            size="main"
            describedBy={`${ROW_ID}-help`}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              api.press('create');
            }}
          />
        ) : null}
        <TileRow
          id={ROW_ID}
          label={O.rowLabel}
          columns={3}
          help={view.help.text}
          helpTone={view.help.tone}
          helpLive="polite"
        >
          {view.tiles.map((tile) => (
            <Tile
              key={tile.id}
              id={tile.id}
              label={tile.label}
              help={tile.help}
              mnemonic={tile.mnemonic}
              size="text"
              door={tile.door}
              secondary={tile.id === 'skip'}
              disabled={tile.disabled || api.finishing}
              disabledReason={tile.disabledReason}
              onPress={() => api.press(tile.id)}
            />
          ))}
        </TileRow>
        <ol className="ob-dots" aria-hidden="true">
          {view.dots.map((dot, index) => (
            <li key={index} className="ob-dot" data-state={dot} />
          ))}
        </ol>
      </Section>
    </div>
  );
}
