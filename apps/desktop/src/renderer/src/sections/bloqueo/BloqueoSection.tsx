/**
 * Section 2 «Bloqueo» (PROMPT §10 «Secciones, 2. Bloqueo»; docs/DESKTOP.md §7.6): the header
 * says the state («Bloqueo: YouTube, Instagram · Estricto» · «hasta 17:42»), and the body is
 * one of: the field and templates (idle, finished), the confirmation card (confirm, pending,
 * failed) or the block (active, punishment, boot hold). Everything shown comes from
 * `deriveBloqueoView`; this component only maps it to the UI kit.
 */
import { Pill, Section } from '../../components';
import { ActiveBlock } from './ActiveBlock';
import { Composer } from './Composer';
import { FitText } from './FitText';
import { ConfirmCard } from './ConfirmCard';
import { BLOQUEO_ES } from './i18n/es';
import { SECTION_ICON } from './icons';
import { useBloqueo } from './useBloqueo';
import { BLOQUEO_SECTION_ID } from './view';
import { useAppStore } from '../../store/context';
import './bloqueo.css';

export function BloqueoSection(): React.JSX.Element {
  const { view, actions, refs, notice } = useBloqueo();
  const intentId = useAppStore((s) => s.main.card?.intentId ?? null);
  const { header, body } = view;
  return (
    <Section
      id={BLOQUEO_SECTION_ID}
      icon={SECTION_ICON}
      title={
        <FitText
          candidates={header.titles}
          fitKey={`${header.datum ?? ''}|${header.newPill ? 'pill' : ''}`}
        />
      }
      datum={header.datum}
      datumTone={header.datumTone}
      pill={
        header.newPill ? (
          <Pill tone="blue" onPress={actions.openNew}>
            <span aria-hidden="true">{BLOQUEO_ES.header.newPill}</span>
            <span className="sr-only">{BLOQUEO_ES.header.newPillLabel}</span>
          </Pill>
        ) : undefined
      }
    >
      {body.kind === 'composer' ? (
        <Composer composer={body.composer} actions={actions} refs={refs} />
      ) : body.kind === 'card' ? (
        <ConfirmCard
          card={body}
          actions={actions}
          refs={refs}
          notice={notice}
          intentId={intentId}
        />
      ) : (
        <ActiveBlock active={body} actions={actions} refs={refs} notice={notice} />
      )}
    </Section>
  );
}
