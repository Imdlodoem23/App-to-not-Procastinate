/**
 * «Qué bloquear: YouTube +1», the left column of the form: catalog search, the six categories
 * and «Otros» with checkboxes (a group opens to show its services), then «Dominios propios» and
 * «Apps del ordenador». In Examen the whitelist replaces the picker (it blocks everything else).
 *
 * The results under the search box are not a live region (every keystroke would read every
 * service again): the window announces their count once the typing stops.
 */
import { AppWindow, Globe, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Checkbox, Field, HelpLine, Section, Tile } from '../../components';
import { ESC_PRIORITY } from '../../hooks/keys';
import { useEscape } from '../../hooks/useKeys';
import type { CategoryId } from '@centrate/shared/catalog';
import type { CatalogGroup, ServiceOption } from './catalog';
import { BLOQUEOS } from './i18n';
import { EntryChip, ExpandButton, SuggestionChip, isPlainEnter } from './parts';
import type { BloqueosActions, Notice } from './useBloqueosWindow';
import { BLOQUEOS_IDS, BLOQUEOS_KEYS, type TargetsView } from './view';

const T = BLOQUEOS.targets;

function ServiceGrid(props: {
  id: string;
  services: readonly ServiceOption[];
  actions: BloqueosActions;
}): React.JSX.Element {
  return (
    <div id={props.id} className="blq-services">
      {props.services.map((service) => (
        <Checkbox
          key={service.id}
          checked={service.checked}
          disabled={service.includedBy !== null}
          label={service.name}
          onChange={(on) => props.actions.toggleService(service.id, on)}
        />
      ))}
    </div>
  );
}

function GroupRow(props: {
  group: CatalogGroup;
  expanded: boolean;
  onExpand(): void;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { group, expanded, actions } = props;
  const listId = `blq-group-${group.id}`;
  const categoryId: CategoryId | null = group.categoryId;
  return (
    <div className="blq-group" data-group={group.id}>
      <div className="blq-group-row">
        {categoryId ? (
          <Checkbox
            checked={group.checked}
            label={group.name}
            onChange={(on) => actions.toggleCategory(categoryId, on)}
          />
        ) : (
          <span className="blq-group-name">
            {group.name} <span className="blq-muted">· {T.otrosNote}</span>
          </span>
        )}
        <ExpandButton expanded={expanded} controls={listId} onPress={props.onExpand}>
          {expanded ? T.hide : T.show(group.services.length)}
        </ExpandButton>
      </div>
      {expanded ? (
        <>
          {group.checked ? <p className="blq-note">{T.includedIn(group.name)}</p> : null}
          <ServiceGrid id={listId} services={group.services} actions={actions} />
        </>
      ) : null}
    </div>
  );
}

export function TargetsSection(props: {
  view: TargetsView;
  search: string;
  domainInput: string;
  processInput: string;
  seedLine: string | null;
  notices: { domains?: Notice; apps?: Notice };
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions, notices } = props;
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());

  const expanded = (group: CatalogGroup): boolean => {
    const byDefault = group.picked > 0;
    return toggled.has(group.id) ? !byDefault : byDefault;
  };
  const flip = (id: string): void =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Esc with text in the search box clears it before anything else closes.
  useEscape(
    ESC_PRIORITY.clearText,
    () => {
      if (props.search === '') return false;
      actions.setSearch('');
      return true;
    },
    props.search !== '',
  );

  const domainsHelpId = 'blq-domains-help';
  const appsHelpId = 'blq-apps-help';

  return (
    <Section id={BLOQUEOS_IDS.targets} icon={ListChecks} title={view.title}>
      {props.seedLine ? <p className="blq-note">{props.seedLine}</p> : null}
      {view.whitelist ? (
        <p className="blq-text">
          {view.whitelist.intro} <span className="blq-muted">{view.whitelist.list}</span>
        </p>
      ) : (
        <>
          <Field
            id={BLOQUEOS_IDS.search}
            value={props.search}
            label={T.searchLabel}
            placeholder={T.searchPlaceholder}
            onChange={actions.setSearch}
            onKeyDown={(event) => {
              if (!isPlainEnter(event)) return;
              event.preventDefault();
              actions.pickFirstResult();
            }}
          />
          {view.search ? (
            <div className="blq-results">
              {view.search.categories.map((group) => (
                <div key={group.id} className="blq-group-row">
                  <Checkbox
                    checked={group.checked}
                    label={group.name}
                    onChange={(on) =>
                      group.categoryId ? actions.toggleCategory(group.categoryId, on) : undefined
                    }
                  />
                </div>
              ))}
              {view.search.services.length > 0 ? (
                <ServiceGrid
                  id="blq-search-results"
                  services={view.search.services}
                  actions={actions}
                />
              ) : null}
              {view.search.categories.length === 0 && view.search.services.length === 0 ? (
                <p className="blq-note">{T.noResults}</p>
              ) : null}
            </div>
          ) : (
            <div className="blq-groups" role="group" aria-label={T.groupsLabel}>
              {view.groups.map((group) => (
                <GroupRow
                  key={group.id}
                  group={group}
                  expanded={expanded(group)}
                  onExpand={() => flip(group.id)}
                  actions={actions}
                />
              ))}
            </div>
          )}
          <div className="blq-entries">
            <div className="blq-col">
              <div className="blq-label">{T.domains.label}</div>
              <div className="blq-field-row">
                <Field
                  value={props.domainInput}
                  label={T.domains.label}
                  placeholder={T.domains.placeholder}
                  describedBy={domainsHelpId}
                  invalid={notices.domains?.tone === 'orange'}
                  onChange={actions.setDomainInput}
                  onKeyDown={(event) => {
                    if (!isPlainEnter(event)) return;
                    event.preventDefault();
                    actions.addDomain();
                  }}
                />
                <Tile
                  id="blq-add-domain"
                  label={T.domains.add}
                  icon={Globe}
                  size="text"
                  mnemonic={BLOQUEOS_KEYS.addDomain}
                  describedBy={domainsHelpId}
                  onPress={actions.addDomain}
                />
              </div>
              {view.domains.length > 0 ? (
                <div className="blq-chips">
                  {view.domains.map((entry) => (
                    <EntryChip
                      key={entry.key}
                      label={entry.label}
                      ariaLabel={T.remove(entry.label)}
                      describedBy={domainsHelpId}
                      onPress={() => actions.removeEntry(entry)}
                    />
                  ))}
                </div>
              ) : null}
              <HelpLine
                id={domainsHelpId}
                tone={notices.domains?.tone ?? 'muted'}
                className="blq-wrap"
              >
                {notices.domains?.text ?? (view.domains.length > 0 ? T.removeHelp : T.domains.help)}
              </HelpLine>
            </div>
            <div className="blq-col">
              <div className="blq-label">{T.apps.label}</div>
              <div className="blq-field-row">
                <Field
                  value={props.processInput}
                  label={T.apps.label}
                  placeholder={T.apps.placeholder}
                  describedBy={appsHelpId}
                  invalid={notices.apps?.tone === 'orange'}
                  onChange={actions.setProcessInput}
                  onKeyDown={(event) => {
                    if (!isPlainEnter(event)) return;
                    event.preventDefault();
                    actions.addProcess();
                  }}
                />
                <Tile
                  id="blq-add-app"
                  label={T.apps.add}
                  icon={AppWindow}
                  size="text"
                  mnemonic={BLOQUEOS_KEYS.addApp}
                  describedBy={appsHelpId}
                  onPress={actions.addProcess}
                />
              </div>
              {view.suggestions.length > 0 ? (
                <div className="blq-chips" role="group" aria-label={T.apps.suggestionsLabel}>
                  {view.suggestions.map((s) => (
                    <SuggestionChip
                      key={s.kind === 'app' ? `app:${s.id}` : `proc:${s.name}`}
                      label={s.label}
                      ariaLabel={`${T.apps.add} ${s.label}`}
                      onPress={() => actions.addSuggestion(s)}
                    />
                  ))}
                </div>
              ) : null}
              {view.apps.length > 0 ? (
                <div className="blq-chips">
                  {view.apps.map((entry) => (
                    <EntryChip
                      key={`${entry.kind}:${entry.key}`}
                      label={entry.label}
                      ariaLabel={T.remove(entry.label)}
                      describedBy={appsHelpId}
                      onPress={() => actions.removeEntry(entry)}
                    />
                  ))}
                </div>
              ) : null}
              <HelpLine id={appsHelpId} tone={notices.apps?.tone ?? 'muted'} className="blq-wrap">
                {notices.apps?.text ?? (view.apps.length > 0 ? T.removeHelp : T.apps.help)}
              </HelpLine>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
