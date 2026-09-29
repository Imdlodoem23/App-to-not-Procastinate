/**
 * «Tu lista blanca: 3 extras · 1 esperando», under the exam tiles (PROMPT §9 «Modo examen»):
 * the webs and apps the user adds to the study whitelist, as removable chips (a pending
 * addition is dashed and says when it applies: «geogebra.org · desde mañana 17:10»), and a web
 * field and an app field with «Permitir». Adding waits 24 h (the guardian's rule for loosening);
 * removing applies at once. Distractions are refused with the reason.
 *
 * Results show on the help line (not a live region: the window's polite region reads them).
 *
 * Removing a chip (or allowing a suggestion, which then leaves the suggestions) unmounts the
 * focused button once the guardian accepts it; the focus moves to the chip that took its place,
 * else the previous one, else the field of that kind, never to <body> (WCAG 2.4.3).
 */
import { AppWindow, Globe } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Field, HelpLine, TextButton, Tile } from '../../components';
import { errorCopy } from '../../i18n/errors';
import { BLOQUEOS } from './i18n';
import { EntryChip, SuggestionChip, isPlainEnter } from './parts';
import type { BloqueosActions, Notice } from './useBloqueosWindow';
import { BLOQUEOS_IDS, BLOQUEOS_KEYS, type ExamWhitelistView } from './view';
import type { WhitelistKind } from './whitelist';

const W = BLOQUEOS.exam.whitelist;

/** The chip whose press may unmount it: where it was, and which field is the last resort. */
interface FocusIntent {
  button: HTMLElement;
  list: 'entries' | 'suggestions';
  index: number;
  kind: WhitelistKind;
}

function isFocusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && !(el instanceof HTMLInputElement && el.disabled);
}

export function WhitelistEditor(props: {
  view: ExamWhitelistView;
  domainInput: string;
  processInput: string;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions, notice } = props;
  const helpId = `${BLOQUEOS_IDS.whitelist}-help`;
  const titleId = `${BLOQUEOS_IDS.whitelist}-title`;
  const ready = view.status === 'ready';
  const savingReason = view.saving ? BLOQUEOS.schedules.editor.saving : undefined;

  const groupRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const domainRef = useRef<HTMLInputElement>(null);
  const processRef = useRef<HTMLInputElement>(null);
  const intent = useRef<FocusIntent | null>(null);

  const remember = (list: FocusIntent['list'], index: number, kind: FocusIntent['kind']): void => {
    const active = document.activeElement;
    intent.current =
      active instanceof HTMLElement && active.closest('.blq-chip') === active
        ? { button: active, list, index, kind }
        : null;
  };

  // Once the pressed chip is gone (the guardian accepted the change), give the focus to its
  // neighbour or its field, unless the user already moved it somewhere else.
  useLayoutEffect(() => {
    const pending = intent.current;
    if (!pending || pending.button.isConnected) return;
    intent.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const container = pending.list === 'entries' ? entriesRef.current : suggestionsRef.current;
    const chips = container
      ? Array.from(container.querySelectorAll<HTMLElement>(':scope > .blq-chip'))
      : [];
    const field = pending.kind === 'domain' ? domainRef.current : processRef.current;
    const target = [chips[pending.index], chips[pending.index - 1], field].find(isFocusable);
    (target ?? groupRef.current?.closest<HTMLElement>('[data-section]'))?.focus({
      preventScroll: false,
    });
  }, [view.entries, view.suggestions, view.status]);

  return (
    <div ref={groupRef} className="blq-whitelist" role="group" aria-labelledby={titleId}>
      <h3 id={titleId} className="blq-editor-title">
        {view.title}
      </h3>
      {view.status === 'error' && view.error ? (
        <div className="blq-inline">
          <HelpLine tone="red">{errorCopy(view.error).text}</HelpLine>
          <TextButton tone="blue" onPress={actions.retrySettings}>
            {W.retry}
          </TextButton>
        </div>
      ) : null}
      {view.entries.length > 0 ? (
        <div ref={entriesRef} className="blq-chips" role="group" aria-label={W.listLabel}>
          {view.entries.map((entry, index) => (
            <EntryChip
              key={`${entry.kind}:${entry.value}`}
              label={entry.label}
              ariaLabel={entry.removeLabel}
              describedBy={helpId}
              pending={entry.pendingWhen !== null}
              onPress={() => {
                remember('entries', index, entry.kind);
                actions.removeWhitelistEntry(entry);
              }}
            />
          ))}
        </div>
      ) : null}
      {ready ? (
        <div className="blq-two">
          <div className="blq-col">
            <div className="blq-label">{W.domainsLabel}</div>
            <div className="blq-field-row">
              <Field
                id={BLOQUEOS_IDS.whitelistDomain}
                ref={domainRef}
                value={props.domainInput}
                label={W.domainsLabel}
                placeholder={W.domainPlaceholder}
                describedBy={helpId}
                invalid={notice?.tone === 'orange'}
                disabled={view.full.domains}
                onChange={actions.setWhitelistDomainInput}
                onKeyDown={(event) => {
                  if (!isPlainEnter(event)) return;
                  event.preventDefault();
                  actions.allowDomain();
                }}
              />
              <Tile
                id="blq-allow-domain"
                label={W.add}
                icon={Globe}
                size="text"
                mnemonic={BLOQUEOS_KEYS.allowDomain}
                help={W.addDomainHelp}
                describedBy={helpId}
                disabled={view.saving || view.full.domains}
                disabledReason={savingReason}
                onPress={actions.allowDomain}
              />
            </div>
          </div>
          <div className="blq-col">
            <div className="blq-label">{W.appsLabel}</div>
            <div className="blq-field-row">
              <Field
                ref={processRef}
                value={props.processInput}
                label={W.appsLabel}
                placeholder={W.appPlaceholder}
                describedBy={helpId}
                invalid={notice?.tone === 'orange'}
                disabled={view.full.processes}
                onChange={actions.setWhitelistProcessInput}
                onKeyDown={(event) => {
                  if (!isPlainEnter(event)) return;
                  event.preventDefault();
                  actions.allowProcess();
                }}
              />
              <Tile
                id="blq-allow-app"
                label={W.add}
                icon={AppWindow}
                size="text"
                mnemonic={BLOQUEOS_KEYS.allowApp}
                help={W.addAppHelp}
                describedBy={helpId}
                disabled={view.saving || view.full.processes}
                disabledReason={savingReason}
                onPress={actions.allowProcess}
              />
            </div>
            {view.suggestions.length > 0 ? (
              <div
                ref={suggestionsRef}
                className="blq-chips"
                role="group"
                aria-label={W.suggestionsLabel}
              >
                {view.suggestions.map((name, index) => (
                  <SuggestionChip
                    key={name}
                    label={name}
                    ariaLabel={`${W.add} ${name}`}
                    onPress={() => {
                      remember('suggestions', index, 'process');
                      actions.allowSuggestion(name);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <HelpLine id={helpId} tone={notice?.tone ?? 'muted'} className="blq-wrap">
        {notice?.text ?? W.help}
      </HelpLine>
    </div>
  );
}
