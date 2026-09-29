/**
 * The Ajustes detail window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle › Ajustes»;
 * docs/DESKTOP.md §7.7, §15). Default export, no props: `DetailWindow` loads it lazily.
 *
 * G-Helper's «Extra»: groups of 48 px rows, title and description on the left and the control on
 * the right, everything applied at once (no «Guardar»). Choices («Tema», «Objetivo diario»,
 * «Modo por defecto») are compact tiles on the right, the description saying what the hovered
 * or focused option does; the punishment level is a full-width row whose help line explains each
 * level. Opened on a group («Detalles…» asks for Sistema), it scrolls there.
 *
 * Results are announced from regions that are there before them: each group's notice slot,
 * empty and zero-height until something happens, then only its text changes (the new pairing
 * code and «Copiado» are already on screen, so their slots speak without showing). Every tile
 * has an Alt + letter and is described by its row.
 */
import {
  BookOpen,
  ClipboardCopy,
  Database,
  Download,
  FileDown,
  KeyRound,
  MonitorCog,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Trash,
  Wrench,
} from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import {
  Countdown,
  Field,
  Section,
  SettingsRow,
  StatusDot,
  Tile,
  TileRow,
  Toggle,
  settingsRowIds,
} from '../../components';
import type { ThemePreference } from '@centrate/shared/design/tokens';
import type { LanguagePreference } from '../../../../shared/i18n/locale';
import { useLocaleSwitch } from '../../app/Localized';
import { SoundTile } from '../../features/sounds';
import { useRepair } from '../../hooks/useRepair';
import { useAppStore } from '../../store/context';
import { formatInt } from '../../../../shared/format';
import type { DefaultBlockMode } from '../../../../shared/ui-state';
import { AJUSTES } from './i18n';
import { ChoiceRow, Notice, PunishmentRow, RangeRow, ShortcutRow, VolumeRow } from './parts';
import { useAjustes, type AjustesApi } from './useAjustes';
import { AJUSTES_IDS, type AjustesView } from './view';
import './ajustes.css';

const A = AJUSTES;

/** A settings row with an on/off switch, labelled and described by the row. */
function SwitchRow(props: {
  id: string;
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onChange(on: boolean): void;
}): React.JSX.Element {
  const ids = settingsRowIds(props.id);
  return (
    <SettingsRow id={props.id} title={props.title} description={props.description}>
      <Toggle
        checked={props.checked}
        labelledBy={ids.title}
        describedBy={ids.description}
        onChange={props.onChange}
      />
    </SettingsRow>
  );
}

/** «Guardián: Activo» with its dot (the Sistema rows' titles). */
function StatusTitle(props: {
  tone: React.ComponentProps<typeof StatusDot>['tone'];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="aj-status">
      <StatusDot tone={props.tone} />
      {props.children}
    </span>
  );
}

function GeneralGroup(props: { view: AjustesView['general']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  const platform = useAppStore((s) => s.snapshot.app.platform);
  const goal = view.dailyGoal;
  return (
    <Section id={AJUSTES_IDS.general} icon={SlidersHorizontal} title={view.title}>
      <div className="aj-rows">
        <ChoiceRow<LanguagePreference>
          id="aj-language-row"
          rowId={AJUSTES_IDS.rows.language}
          title={A.general.language}
          description={A.general.languageDesc}
          value={view.language}
          options={view.languageOptions.map((o) => ({ ...o, tone: 'neutral' as const }))}
          onChange={api.setLanguage}
        />
        <ChoiceRow<ThemePreference>
          id="aj-theme-row"
          rowId={AJUSTES_IDS.rows.theme}
          title={A.general.themeLabel}
          description={A.general.themeRowHelp}
          value={view.theme}
          options={view.themeOptions.map((o) => ({ ...o, tone: 'neutral' as const }))}
          onChange={api.setTheme}
        />
        <SwitchRow
          id="aj-autostart"
          title={A.general.autostart}
          description={A.general.autostartDesc}
          checked={view.autostart}
          onChange={api.setAutostart}
        />
        {goal?.options ? (
          <ChoiceRow<string>
            id="aj-goal-row"
            rowId={AJUSTES_IDS.rows.goal}
            title={A.general.dailyGoal}
            description={A.general.dailyGoalDesc}
            note={goal.note}
            columns={4}
            value={goal.selected === null ? null : String(goal.selected)}
            options={goal.options.map((o) => ({ ...o, value: String(o.value) }))}
            onChange={(value) => api.setDailyGoal(Number(value))}
          />
        ) : goal ? (
          <SettingsRow
            id="aj-daily-goal"
            title={A.general.dailyGoal}
            description={
              goal.note ? <span data-tone="orange">{goal.note}</span> : A.general.dailyGoalDesc
            }
          >
            <span className="aj-value">{goal.value}</span>
          </SettingsRow>
        ) : null}
        {view.sounds ? (
          <>
            <SettingsRow id="aj-sound" title={A.general.sound} description={A.general.soundDesc}>
              <SoundTile
                id="aj-sound-tile"
                size="text"
                mnemonic={view.sounds.key}
                describedBy={settingsRowIds('aj-sound').description}
              />
            </SettingsRow>
            <VolumeRow volume={view.sounds.volume} onCommit={api.setVolume} />
            <SwitchRow
              id="aj-autoplay"
              title={A.general.autoplay}
              description={A.general.autoplayDesc}
              checked={view.sounds.autoplay}
              onChange={api.setAutoplay}
            />
          </>
        ) : null}
        {view.osd !== null ? (
          <SwitchRow
            id="aj-osd"
            title={A.general.osd}
            description={A.general.osdDesc}
            checked={view.osd}
            onChange={api.setOsd}
          />
        ) : null}
      </div>
      <Notice notice={api.notices.general} />
      <div className="aj-rows">
        {view.shortcuts.map((row) => (
          <ShortcutRow
            key={row.action}
            row={row}
            platform={platform}
            onCapture={api.setCapturing}
            onSave={api.setShortcut}
            onHint={api.shortcutHint}
          />
        ))}
      </div>
      <Notice notice={api.notices.shortcuts} />
    </Section>
  );
}

function BloqueoGroup(props: { view: AjustesView['bloqueo']; api: AjustesApi }): React.JSX.Element {
  const { view, api } = props;
  const penalties = view.guardianSettings.find((r) => r.field === 'attemptPenalties');
  const others = view.guardianSettings.filter((r) => r.field !== 'attemptPenalties');
  const setters = {
    attemptPenalties: api.setPenalties,
    closeBrowsersWithoutExtension: api.setCloseBrowsers,
  } as const;
  const settingRow = (row: AjustesView['bloqueo']['guardianSettings'][number]) => (
    <SwitchRow
      key={row.field}
      id={`aj-${row.field}`}
      title={row.title}
      description={row.note ? <span data-tone="orange">{row.note}</span> : row.description}
      checked={row.value}
      onChange={setters[row.field]}
    />
  );
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
        {view.settingsStatus !== null ? (
          <SettingsRow
            id="aj-guardian-settings"
            title={A.bloqueo.guardianSettings}
            description={view.settingsStatus}
          >
            {null}
          </SettingsRow>
        ) : null}
        {penalties ? settingRow(penalties) : null}
      </div>
      <dl className="aj-values" aria-label={A.bloqueo.values.label}>
        {view.values.map((item) => (
          <div key={item.label} className="aj-values-row">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <div className="aj-rows">
        {others.map(settingRow)}
        {view.reminders ? (
          <>
            <SwitchRow
              id="aj-reminders"
              title={A.bloqueo.reminders}
              description={view.reminders.schedulesDesc}
              checked={view.reminders.schedules}
              onChange={api.setReminders}
            />
            <SwitchRow
              id="aj-eye-breaks"
              title={A.bloqueo.eyeBreaks}
              description={A.bloqueo.eyeBreaksDesc}
              checked={view.reminders.eyeBreaks}
              onChange={api.setEyeBreaks}
            />
          </>
        ) : null}
      </div>
      <Notice notice={api.notices.bloqueo} />
    </Section>
  );
}

function StudyGroup(props: {
  view: NonNullable<AjustesView['study']>;
  api: AjustesApi;
}): React.JSX.Element {
  const { view, api } = props;
  const duration = view.duration;
  return (
    <Section id={AJUSTES_IDS.study} icon={BookOpen} title={view.title}>
      <div className="aj-rows">
        <PunishmentRow view={view} onChange={api.setPunishmentLevel} />
        {duration ? (
          <RangeRow
            id="aj-punishment-minutes"
            title={A.study.duration}
            description={A.study.durationDesc}
            value={duration.minutes}
            min={duration.min}
            max={duration.max}
            step={duration.step}
            format={(minutes) => A.study.durationValue(formatInt(minutes))}
            onCommit={api.setPunishmentMinutes}
          />
        ) : null}
      </div>
      <Notice notice={api.notices.study} />
    </Section>
  );
}

function PairingCode(props: { view: AjustesView['sistema']; api: AjustesApi }): React.JSX.Element {
  const { api } = props;
  const view = props.view.pairing;
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
          mnemonic={props.view.pairingKey}
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
  const updater = view.updater;
  const active = view.activeWindow;
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
            <StatusTitle tone={view.guardian.tone}>
              {A.sistema.guardian}: {view.guardian.status}
            </StatusTitle>
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
              mnemonic={view.repairKey}
              describedBy={settingsRowIds('aj-guardian').description}
              disabled={repair.running}
              onPress={repair.run}
            />
          ) : null}
        </SettingsRow>
        {view.extensions.length === 0 ? (
          <SettingsRow
            id="aj-extension-none"
            title={<StatusTitle tone="orange">{A.sistema.extensionNone}</StatusTitle>}
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
              <StatusTitle tone={ext.tone}>
                {ext.title}: {ext.status}
              </StatusTitle>
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
            title={<StatusTitle tone="orange">{m.title}</StatusTitle>}
            description={A.sistema.browserMissingDesc}
          >
            {null}
          </SettingsRow>
        ))}
        <PairingCode view={view} api={api} />
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
          id="aj-active-window"
          title={
            <StatusTitle tone={active.tone}>
              {A.sistema.activeWindow.title}: {active.status}
            </StatusTitle>
          }
          description={active.description}
        >
          {active.allowKey ? (
            <Tile
              id="aj-active-window-allow"
              label={A.sistema.activeWindow.allow}
              size="text"
              door
              mnemonic={active.allowKey}
              describedBy={settingsRowIds('aj-active-window').description}
              disabled={api.busy.has('activewin')}
              onPress={api.requestScreenPermission}
            />
          ) : null}
        </SettingsRow>
        {view.camera ? (
          <SettingsRow
            id="aj-camera"
            title={
              <StatusTitle tone="neutral">
                {A.sistema.camera.title}: {view.camera.status}
              </StatusTitle>
            }
            description={view.camera.description}
          >
            {null}
          </SettingsRow>
        ) : null}
        {updater ? (
          <SettingsRow
            id="aj-updater"
            title={
              <StatusTitle tone={updater.tone}>
                {A.sistema.updater.title}: {updater.status}
              </StatusTitle>
            }
            description={updater.description}
          >
            {updater.action ? (
              <Tile
                id="aj-updater-action"
                label={updater.action.label}
                icon={updater.action.kind === 'install' ? RotateCcw : Download}
                size="text"
                mnemonic={updater.action.key}
                describedBy={settingsRowIds('aj-updater').description}
                disabled={updater.action.disabled || api.busy.has('updater')}
                onPress={() => updater.action && api.updaterAction(updater.action.kind)}
              />
            ) : null}
          </SettingsRow>
        ) : null}
        {view.onboardingKey ? (
          <SettingsRow
            id="aj-onboarding"
            title={A.sistema.onboarding.title}
            description={A.sistema.onboarding.desc}
          >
            <Tile
              id="aj-onboarding-again"
              label={A.sistema.onboarding.action}
              size="text"
              mnemonic={view.onboardingKey}
              describedBy={settingsRowIds('aj-onboarding').description}
              onPress={api.restartOnboarding}
            />
          </SettingsRow>
        ) : null}
      </div>
      <Notice notice={api.notices.sistema} />
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
            mnemonic={view.diagnosticsKey}
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
  const exportIds = settingsRowIds('aj-export');
  return (
    <Section id={AJUSTES_IDS.datos} icon={Database} title={A.datos.title}>
      <div className="aj-rows">
        {view.export ? (
          <SettingsRow id="aj-export" title={A.datos.export} description={A.datos.exportDesc}>
            <Tile
              id="aj-export-events"
              label={A.datos.exportEvents}
              icon={FileDown}
              size="text"
              door
              mnemonic={view.export.events}
              describedBy={exportIds.description}
              disabled={api.busy.has('export')}
              onPress={() => api.exportCsv('events')}
            />
            <Tile
              id="aj-export-days"
              label={A.datos.exportDays}
              size="text"
              door
              mnemonic={view.export.days}
              describedBy={exportIds.description}
              disabled={api.busy.has('export')}
              onPress={() => api.exportCsv('days')}
            />
          </SettingsRow>
        ) : null}
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
            mnemonic={view.deleteKey}
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

/**
 * The «Tema» row's tab stop: its checked tile (TileRow keeps it at tabIndex 0). Not «Idioma»,
 * the first row: an arrow key there would switch the whole window's language.
 */
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
  // stop, else the checked «Tema» tile. Once per request: a language switch remounts the
  // window with the same request, and then `Localized` puts the focus back on the «Idioma» tile.
  const localeSwitch = useLocaleSwitch();
  const doorFor = useRef<typeof request>(null);
  useLayoutEffect(() => {
    if (!request || doorFor.current === request) return;
    doorFor.current = request;
    if (localeSwitch.current) return;
    const section = request.group
      ? document.querySelector<HTMLElement>(`[data-section="aj-${request.group}"]`)
      : null;
    section?.scrollIntoView({ block: 'start' });
    const target = section ? firstTabStop(section) : themeTabStop();
    target?.focus({ preventScroll: true });
  }, [request, localeSwitch]);

  return (
    <div className="aj" data-loading={api.loading ? '' : undefined}>
      <GeneralGroup view={api.view.general} api={api} />
      <BloqueoGroup view={api.view.bloqueo} api={api} />
      {api.view.study ? <StudyGroup view={api.view.study} api={api} /> : null}
      <SistemaGroup view={api.view.sistema} api={api} />
      <DatosGroup view={api.view.datos} api={api} />
    </div>
  );
}
