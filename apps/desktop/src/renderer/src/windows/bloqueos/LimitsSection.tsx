/**
 * «Límites diarios» of the Bloqueos window (ARCHITECTURE §5.10): one row per limit («YouTube ·
 * 30 min al día», its icon, today's bar «12 de 30 min hoy», «Bloqueado hasta mañana» once used
 * up, the pending change of a softening edit) with «Editar» and, while a change waits,
 * «Cancelar cambio»; then «Nuevo límite» or the editor in place (Esc closes it).
 *
 * Results show under the list without being live regions (they mount with the text in them);
 * the window's polite region announces them.
 */
import { Hourglass, Pencil, TimerReset, Undo2 } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import {
  Bar,
  HelpLine,
  Icon,
  Section,
  ServiceIcon,
  SettingsRow,
  TextButton,
  Tile,
  TileRow,
  settingsRowIds,
} from '../../components';
import { errorCopy } from '../../i18n/errors';
import { chipIcon } from '../../sections/bloqueo/icons';
import { BLOQUEOS } from './i18n';
import { LimitEditor } from './LimitEditor';
import type { LimitRowView } from './limits';
import type { BloqueosActions, Notice } from './useBloqueosWindow';
import { BLOQUEOS_IDS, BLOQUEOS_KEYS, type LimitsView } from './view';

const E = BLOQUEOS;

function LimitIcon(props: { row: LimitRowView }): React.JSX.Element {
  const { row } = props;
  if (row.monogram !== null) {
    return <ServiceIcon className="blq-limit-icon" monogram={row.monogram} />;
  }
  const glyph = row.categoryId ? chipIcon('category', row.categoryId) : null;
  return (
    <span className="blq-limit-icon" aria-hidden="true">
      <Icon icon={glyph ?? Hourglass} size="header" />
    </span>
  );
}

function LimitRow(props: { row: LimitRowView; actions: BloqueosActions }): React.JSX.Element {
  const { row, actions } = props;
  const id = `blq-limit-${row.id}`;
  const ids = settingsRowIds(id);
  return (
    <SettingsRow
      id={id}
      className="blq-limit-row"
      title={
        <span className="blq-limit-title">
          <LimitIcon row={row} />
          <span>{row.title}</span>
        </span>
      }
      description={
        <span className="blq-limit-desc">
          <Bar
            value={row.usage.value}
            height={4}
            tone={row.usage.tone}
            label={row.usage.label}
            valueText={row.usage.text}
            className="blq-limit-bar"
          />
          <span className="blq-limit-line">
            <span data-tone={row.state?.tone === 'red' ? 'red' : undefined}>{row.usage.text}</span>
            {row.state ? <span data-tone={row.state.tone}>{` · ${row.state.text}`}</span> : null}
            <span>{` · ${row.description}`}</span>
          </span>
          {row.pending ? (
            <span className="blq-limit-line" data-tone="orange">
              {row.pending}
            </span>
          ) : null}
        </span>
      }
    >
      <div className="blq-row-actions" role="group" aria-labelledby={ids.title}>
        {row.pending ? (
          <Tile
            id={`cancel-${row.id}`}
            className="blq-tile-wide"
            label={E.limits.cancelChange}
            icon={Undo2}
            size="text"
            mnemonic={row.cancelKey}
            help={E.limits.cancelChangeHelp}
            describedBy={ids.description}
            disabled={row.saving}
            disabledReason={row.saving ? E.limits.saving : undefined}
            onPress={() => actions.cancelLimitChange(row.id)}
          />
        ) : null}
        <Tile
          id={`edit-${row.id}`}
          label={E.limits.edit}
          icon={Pencil}
          size="text"
          mnemonic={row.editKey}
          help={E.limits.editHelp}
          describedBy={ids.description}
          disabled={row.editing || row.saving}
          onPress={() => actions.editLimit(row.id)}
        />
      </div>
    </SettingsRow>
  );
}

export function LimitsSection(props: {
  view: LimitsView;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions, notice } = props;
  const editorOpen = view.editor !== null;

  // Closing the editor gives the focus back where it was opened from (the row's «Editar», else
  // «Nuevo límite»), never to <body>.
  const openedFrom = useRef<string | null>(null);
  const wasOpen = useRef(editorOpen);
  const editorId = view.editor?.id ?? null;
  if (editorOpen) openedFrom.current = editorId === null ? 'new' : editorId;
  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = editorOpen;
    if (editorOpen) {
      document
        .querySelector<HTMLElement>(`[data-section="${BLOQUEOS_IDS.limits}"] .blq-editor`)
        ?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!was) return;
    const from = openedFrom.current;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target =
      from !== null && from !== 'new'
        ? document.querySelector<HTMLElement>(`[data-tile-id="edit-${CSS.escape(from)}"]`)
        : null;
    (
      target ??
      document.querySelector<HTMLElement>(`[data-tile-id="${BLOQUEOS_IDS.newLimit}"]`) ??
      document.querySelector<HTMLElement>(`[data-section="${BLOQUEOS_IDS.limits}"]`)
    )?.focus({ preventScroll: false });
  }, [editorOpen]);

  const unsupported = view.status === 'unsupported';
  return (
    <Section
      id={BLOQUEOS_IDS.limits}
      icon={TimerReset}
      title={view.title}
      datum={view.datum}
      datumTone="red"
      // A door focuses the section root: the reason nothing can be created is read with it.
      describedBy={unsupported ? BLOQUEOS_IDS.limitsUnsupported : undefined}
    >
      {view.status === 'error' && view.error ? (
        <div className="blq-inline">
          <HelpLine tone="red">{errorCopy(view.error).text}</HelpLine>
          <TextButton tone="blue" onPress={actions.retryLimits}>
            {E.limits.retry}
          </TextButton>
        </div>
      ) : null}
      {unsupported ? (
        <p id={BLOQUEOS_IDS.limitsUnsupported} className="blq-note">
          {E.limits.unsupported}
        </p>
      ) : null}
      {view.status === 'ready' && view.rows.length === 0 && !editorOpen ? (
        <p className="blq-note">{E.limits.empty}</p>
      ) : null}
      {view.rows.length > 0 ? (
        <div className="blq-rows" role="list" aria-label={E.limits.listLabel}>
          {view.rows.map((row) => (
            <div key={row.id} role="listitem">
              <LimitRow row={row} actions={actions} />
            </div>
          ))}
        </div>
      ) : null}
      {view.canCreate ? (
        <TileRow
          id={BLOQUEOS_IDS.rows.newLimit}
          label={E.limits.newLimit}
          columns={3}
          help={E.limits.newLimitHelp}
        >
          <Tile
            id={BLOQUEOS_IDS.newLimit}
            label={E.limits.newLimit}
            icon={Hourglass}
            size="text"
            mnemonic={BLOQUEOS_KEYS.newLimit}
            help={E.limits.newLimitHelp}
            onPress={actions.newLimit}
          />
        </TileRow>
      ) : null}
      {view.editor ? <LimitEditor view={view.editor} actions={actions} /> : null}
      {notice ? (
        <HelpLine tone={notice.tone} className="blq-wrap">
          {notice.text}
        </HelpLine>
      ) : null}
    </Section>
  );
}
