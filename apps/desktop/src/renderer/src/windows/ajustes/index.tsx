/**
 * The Ajustes detail window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle › Ajustes»;
 * docs/DESKTOP.md §7.7). Default export, no props: `DetailWindow` loads it lazily.
 *
 * G-Helper's «Extra»: groups of 48 px rows, title and description on the left and the control on
 * the right, everything applied at once (no «Guardar»). «Tema» and «Modo por defecto» are such
 * rows too: three compact tiles on the right, the description saying what the hovered or
 * focused option does. Opened on a group («Detalles…» asks for Sistema), it scrolls there.
 *
 * Results are announced from regions that are there before them: each group's notice slot,
 * empty and zero-height until something happens, then only its text changes (the new pairing
 * code and «Copiado» are already on screen, so their slots speak without showing). Every tile
 * has an Alt + letter and is described by its row.
 */
import {
  ClipboardCopy,
  Database,
  KeyRound,
  MonitorCog,
  Shield,
  SlidersHorizontal,
  Trash,
  Wrench,
} from 'lucide-react';
import { useLayoutEffect } from 'react';
import {
  Countdown,
  Field,
  Section,
  Segmented,
  SettingsRow,
  StatusDot,
  Tile,
  TileRow,
  Toggle,
  settingsRowIds,
  type SegmentedOption,
} from '../../components';
import type { ThemePreference } from '@centrate/shared/design/tokens';
import type { LanguagePreference } from '../../../../shared/i18n/locale';
import { useHelp } from '../../hooks/useHelp';
import { useRepair } from '../../hooks/useRepair';
import { RENDERER } from '../../i18n/messages';
import { useAppStore } from '../../store/context';
import type { DefaultBlockMode } from '../../../../shared/ui-state';
import { AJUSTES } from './i18n';
import { useAjustes, type AjustesApi, type AjustesNotice } from './useAjustes';
import { AJUSTES_IDS, AJUSTES_KEYS, type AjustesView } from './view';
import './ajustes.css';

const A = AJUSTES;

/**
 * A group's result line: a polite region that is always mounted (zero height while empty), so
 * «Hecho: tus datos se han borrado» is announced when its text arrives.
 */
function Notice(props: { notice: AjustesNotice | undefined }): React.JSX.Element {
  const { notice } = props;
  return (
    <div className="aj-notice" aria-live="polite" aria-atomic="true">
      {notice ? (
        <span
          key={notice.seq}
          className={notice.spokenOnly ? 'sr-only' : 'aj-notice-text'}
          data-tone={notice.tone}
        >
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * «Tema: Sistema | Claro | Oscuro» as a 48 px settings row: title and description on the left
 * (the hovered or focused option's help replaces the description), three compact tiles on the
 * right. The row's own help line stays for screen readers only (the tiles' description).
 */
function ChoiceRow<T extends string>(props: {
  id: string;
  rowId: string;
  title: string;
  description: string;
  value: T;
  options: readonly (SegmentedOption<NoInfer<T>> & { help: string })[];
  onChange(value: NoInfer<T>): void;
}): React.JSX.Element {
  const active = useHelp(props.rowId).active;
  const shown = props.options.find((o) => o.value === active);
  return (
    <SettingsRow
      id={props.id}
      className="aj-choice"
      title={props.title}
      description={shown?.help ?? props.description}
    >
      <Segmented<T>
        id={props.rowId}
        label={props.title}
        columns={3}
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        help={props.description}
      />
    </SettingsRow>
  );
}

function GeneralGroup(props: { view: AjustesView['general']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  const autostart = settingsRowIds('aj-autostart');
  return (
    <Section id={AJUSTES_IDS.general} icon={SlidersHorizontal} title={view.title}>
      <div className="aj-rows">
        <ChoiceRow<ThemePreference>
          id="aj-theme-row"
          rowId={AJUSTES_IDS.rows.theme}
          title={A.general.themeLabel}
          description={A.general.themeRowHelp}
          value={view.theme}
          options={view.themeOptions.map((o) => ({ ...o, tone: 'neutral' as const }))}
          onChange={api.setTheme}
        />
        <ChoiceRow<LanguagePreference>
          id="aj-language-row"
          rowId={AJUSTES_IDS.rows.language}
          title={A.general.language}
          description={A.general.languageDesc}
          value={view.language}
          options={view.languageOptions.map((o) => ({ ...o, tone: 'neutral' as const }))}
          onChange={api.setLanguage}
        />
        <SettingsRow
          id="aj-autostart"
          title={A.general.autostart}
          description={A.general.autostartDesc}
        >
          <Toggle
            checked={view.autostart}
            labelledBy={autostart.title}
            describedBy={autostart.description}
            onChange={api.setAutostart}
          />
        </SettingsRow>
        {view.dailyGoal ? (
          <SettingsRow
            id="aj-daily-goal"
            title={A.general.dailyGoal}
            description={
              view.dailyGoal.note ? (
                <span data-tone="orange">{view.dailyGoal.note}</span>
              ) : (
                A.general.dailyGoalDesc
              )
            }
          >
            <span className="aj-value">{view.dailyGoal.value}</span>
          </SettingsRow>
        ) : null}
      </div>
      <Notice notice={api.notices.general} />
    </Section>
  );
}

function BloqueoGroup(props: { view: AjustesView['bloqueo']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  return (
    <Section id={AJUSTES_IDS.bloqueo} icon={Shield} title={view.title}>
      <div className="aj-rows">
        <ChoiceRow<DefaultBlockMode>
          id="aj-default-mode-row"
          rowId={AJUSTES_IDS.rows.defaultMode}
          title={A.bloqueo.defaultModeLabel}
          description={A.bloqueo.modeRowHelp}
          value={view.defaultMode}
          options={view.modeOptions}
          onChange={api.setDefaultMode}
        />
        {view.guardianSettings.map((row) => (
          <SettingsRow
            key={row.field}
            id={`aj-${row.field}`}
            title={row.title}
            description={row.note ? <span data-tone="orange">{row.note}</span> : row.description}
          >
            <span className="aj-value">
              {row.value ? RENDERER.kit.toggleOn : RENDERER.kit.toggleOff}
            </span>
          </SettingsRow>
        ))}
      </div>
      <Notice notice={api.notices.bloqueo} />
    </Section>
  );
}

function PairingCode(props: {
  view: AjustesView['sistema']['pairing'];
  api: AjustesApi;
}): React.JSX.Element {
  const { view, api } = props;
  return (
    <>
      <SettingsRow
        id="aj-pairing"
        title={A.sistema.pairing}
        description={
          view.kind === 'code' ? (
            <span className="aj-inline">
              <span>{A.sistema.pairingExpires}</span>
              <Countdown endsAt={view.expiresAtMs} size="row" />
              {view.port ? <span>· {view.port}</span> : null}
            </span>
          ) : view.expired ? (
            A.sistema.pairingExpired
          ) : (
            A.sistema.pairingDesc
          )
        }
      >
        <Tile
          id="aj-pairing-new"
          label={A.sistema.pairingNew}
          icon={KeyRound}
          size="text"
          mnemonic={AJUSTES_KEYS.pairingNew}
          describedBy={settingsRowIds('aj-pairing').description}
          disabled={api.busy.has('pairing')}
          onPress={api.newPairingCode}
        />
      </SettingsRow>
      {view.kind === 'code' ? (
        <p className="aj-code" data-selectable="">
          <span aria-hidden="true">{view.code}</span>
          <span className="sr-only">
            {A.sistema.pairingCodeLabel(view.code.split('').join(' '))}
          </span>
        </p>
      ) : null}
      <Notice notice={api.notices.pairing} />
    </>
  );
}

function SistemaGroup(props: { view: AjustesView['sistema']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  const repair = useRepair();
  return (
    <Section
      id={AJUSTES_IDS.sistema}
      icon={MonitorCog}
      title={view.title}
      titleTone={view.titleTone}
    >
      <div className="aj-rows">
        <SettingsRow
          id="aj-guardian"
          title={
            <span className="aj-status">
              <StatusDot tone={view.guardian.tone} />
              {A.sistema.guardian}: {view.guardian.status}
            </span>
          }
          description={
            repair.message ? (
              <span data-tone={repair.message.tone}>{repair.message.text}</span>
            ) : (
              view.guardian.description
            )
          }
        >
          {view.guardian.repair ? (
            <Tile
              id="aj-repair"
              label={repair.running ? A.sistema.repairing : view.guardian.repair}
              icon={Wrench}
              size="text"
              mnemonic={AJUSTES_KEYS.repair}
              describedBy={settingsRowIds('aj-guardian').description}
              disabled={repair.running}
              onPress={repair.run}
            />
          ) : null}
        </SettingsRow>
        {view.extensions.length === 0 ? (
          <SettingsRow
            id="aj-extension-none"
            title={
              <span className="aj-status">
                <StatusDot tone="orange" />
                {A.sistema.extensionNone}
              </span>
            }
            description={A.sistema.extensionNoneDesc}
          >
            {null}
          </SettingsRow>
        ) : null}
        {view.extensions.map((ext) => (
          <SettingsRow
            key={ext.id}
            id={`aj-ext-${ext.id}`}
            title={
              <span className="aj-status">
                <StatusDot tone={ext.tone} />
                {ext.title}: {ext.status}
              </span>
            }
            description={ext.description}
          >
            {ext.guide ? (
              <Tile
                id={`aj-ext-guide-${ext.id}`}
                label={A.sistema.guide}
                size="text"
                door
                mnemonic={ext.guideKey}
                describedBy={settingsRowIds(`aj-ext-${ext.id}`).description}
                onPress={() => ext.guide && api.openGuide(ext.guide)}
              />
            ) : null}
          </SettingsRow>
        ))}
        {view.missing.map((m) => (
          <SettingsRow
            key={m.id}
            id={`aj-missing-${m.id}`}
            title={
              <span className="aj-status">
                <StatusDot tone="orange" />
                {m.title}
              </span>
            }
            description={A.sistema.browserMissingDesc}
          >
            {null}
          </SettingsRow>
        ))}
        <PairingCode view={view.pairing} api={api} />
      </div>
      <TileRow
        id={AJUSTES_IDS.rows.guides}
        label={A.sistema.guidesLabel}
        columns={3}
        help={A.sistema.guidesRowHelp}
      >
        {view.guides.map((guide) => (
          <Tile
            key={guide.id}
            id={guide.id}
            label={guide.label}
            size="text"
            door
            mnemonic={guide.mnemonic}
            help={guide.help}
            onPress={() => api.openGuide(guide.id)}
          />
        ))}
      </TileRow>
      <div className="aj-rows">
        <SettingsRow
          id="aj-diagnostics"
          title={A.sistema.diagnostics}
          description={
            <span data-tone={view.diagnostics.tone}>{view.diagnostics.description}</span>
          }
        >
          <Tile
            id="aj-diagnostics-copy"
            label={A.sistema.diagnosticsCopy}
            icon={ClipboardCopy}
            size="text"
            mnemonic={AJUSTES_KEYS.diagnostics}
            describedBy={settingsRowIds('aj-diagnostics').description}
            disabled={api.busy.has('diagnostics')}
            onPress={api.copyDiagnostics}
          />
        </SettingsRow>
      </div>
      <Notice notice={api.notices.diagnostics} />
    </Section>
  );
}

function DatosGroup(props: { view: AjustesView['datos']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  const ids = settingsRowIds('aj-delete');
  return (
    <Section id={AJUSTES_IDS.datos} icon={Database} title={A.datos.title}>
      <div className="aj-rows">
        <SettingsRow id="aj-delete" title={A.datos.delete} description={view.deleteHelp}>
          <Field
            value={api.deleteWord}
            label={A.datos.deleteWordLabel}
            placeholder={A.datos.deleteWordPlaceholder}
            describedBy={ids.description}
            className="aj-delete-word"
            maxLength={16}
            onChange={api.setDeleteWord}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              api.deleteData();
            }}
          />
          <Tile
            id="aj-delete-go"
            label={api.busy.has('datos') ? A.datos.deleting : A.datos.deleteButton}
            icon={Trash}
            size="text"
            mnemonic={AJUSTES_KEYS.delete}
            describedBy={ids.description}
            disabled={!view.deleteEnabled || api.busy.has('datos')}
            disabledReason={A.datos.deleteNeedsWord}
            onPress={api.deleteData}
          />
        </SettingsRow>
      </div>
      <Notice notice={api.notices.datos} />
    </Section>
  );
}

const TAB_STOPS = 'button, input, select, textarea, a[href], [tabindex]';

/** The first keyboard tab stop inside `root` (enabled, not taken out of the tab order). */
function firstTabStop(root: HTMLElement): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(TAB_STOPS);
  return [...all].find((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled')) ?? null;
}

/** The «Tema» row's tab stop: its checked tile (TileRow keeps it at tabIndex 0). */
function themeTabStop(): HTMLElement | null {
  const tiles = [
    ...document.querySelectorAll<HTMLElement>(`[data-row-tile="${AJUSTES_IDS.rows.theme}"]`),
  ];
  return (
    tiles.find((t) => t.getAttribute('aria-checked') === 'true') ??
    tiles.find((t) => t.tabIndex === 0) ??
    tiles[0] ??
    null
  );
}

export default function AjustesWindow(): React.JSX.Element {
  const api = useAjustes();
  const request = useAppStore((s) => (s.env.detail?.name === 'ajustes' ? s.env.detail : null));

  // «Detalles…» opens on Sistema; the fixtures open on Sistema and Datos.
  // Every door also puts the focus on a control (never <body>): the requested group's first tab
  // stop, else the checked «Tema» tile.
  useLayoutEffect(() => {
    if (!request) return;
    const section = request.group
      ? document.querySelector<HTMLElement>(`[data-section="aj-${request.group}"]`)
      : null;
    section?.scrollIntoView({ block: 'start' });
    const target = section ? firstTabStop(section) : themeTabStop();
    target?.focus({ preventScroll: true });
  }, [request]);

  return (
    <div className="aj">
      <GeneralGroup view={api.view.general} api={api} />
      <BloqueoGroup view={api.view.bloqueo} api={api} />
      <SistemaGroup view={api.view.sistema} api={api} />
      <DatosGroup view={api.view.datos} api={api} />
    </div>
  );
}
