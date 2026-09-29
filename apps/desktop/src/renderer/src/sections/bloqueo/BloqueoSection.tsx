/**
 * Section 2 «Bloqueo» (PROMPT §10 «Secciones, 2. Bloqueo»; docs/DESKTOP.md §7.6): the header
 * says the state («Bloqueo: YouTube, Instagram · Estricto» · «hasta 17:42»), and the body is
 * one of: the field and templates (idle, finished), the confirmation card (confirm, pending,
 * failed) or the block (active, punishment, boot hold). Everything shown comes from
 * `deriveBloqueoView`; this component only maps it to the UI kit.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pill, Section } from '../../components';
import { ActiveBlock } from './ActiveBlock';
import { Composer } from './Composer';
import { useFitText } from './FitText';
import { ConfirmCard } from './ConfirmCard';
import { LimitCard } from './LimitCard';
import { BLOQUEO } from './i18n';
import { SECTION_ICON } from './icons';
import { useBloqueo } from './useBloqueo';
import { BLOQUEO_SECTION_ID } from './view';
import { useAppStore } from '../../store/context';
import './bloqueo.css';

export function BloqueoSection(): React.JSX.Element {
  const { view, actions, refs, notice } = useBloqueo();
  const intentId = useAppStore((s) => s.main.card?.intentId ?? null);
  const { header, body } = view;
  // The longest title that fits on one line; if none does, the header wraps (never «Cosa:» cut).
  const title = useFitText(header.titles, `${header.datum ?? ''}|${header.newPill ? 'pill' : ''}`);
  // The card's results for screen readers. Always mounted (before any card opens), so the
  // first result is spoken; `seq` re-mounts the text so the same sentence twice is spoken twice.
  const [said, setSaid] = useState({ text: '', seq: 0 });
  const announce = useCallback((text: string) => {
    setSaid((s) => ({ text, seq: s.seq + 1 }));
  }, []);
  // «Límite creado: YouTube, 30 min al día» under the field: spoken once.
  const composerNotice = notice?.scope === 'composer' ? notice.text : null;
  useEffect(() => {
    if (composerNotice !== null) announce(composerNotice);
  }, [composerNotice, announce]);
  return (
    <Section
      id={BLOQUEO_SECTION_ID}
      icon={SECTION_ICON}
      title={<span ref={title.ref}>{title.text}</span>}
      wrap={title.wrap}
      datum={header.datum}
      datumTone={header.datumTone}
      pill={
        header.newPill ? (
          <Pill tone="blue" onPress={actions.openNew}>
            <span aria-hidden="true">{BLOQUEO.header.newPill}</span>
            <span className="sr-only">{BLOQUEO.header.newPillLabel}</span>
          </Pill>
        ) : undefined
      }
    >
      {body.kind === 'composer' ? (
        <Composer composer={body.composer} actions={actions} refs={refs} notice={notice} />
      ) : body.kind === 'limit-card' ? (
        <LimitCard card={body} actions={actions} refs={refs} announce={announce} />
      ) : body.kind === 'card' ? (
        <ConfirmCard
          card={body}
          actions={actions}
          refs={refs}
          notice={notice}
          intentId={intentId}
          announce={announce}
        />
      ) : (
        <ActiveBlock active={body} actions={actions} refs={refs} notice={notice} />
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {said.text ? <span key={said.seq}>{said.text}</span> : null}
      </span>
    </Section>
  );
}
