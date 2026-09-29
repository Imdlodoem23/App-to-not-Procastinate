/**
 * Data and actions of the Ajustes window.
 *
 * - App preferences apply at once through `prefs:set` (main reacts to the snapshot: theme,
 *   autostart, shortcuts, the OSD…). Nested ones merge key by key (`{ sounds: { volume } }`).
 * - The guardian's settings (daily goal, penalties, «cerrar navegadores», punishment level) are
 *   read with `settings:get` while the window is visible (again when the link, the pending
 *   changes or the goal in force change) and written with `settings:put`, always whole. A
 *   weakening change comes back pending: the row says when it applies and the group's notice
 *   says «Se aplicará en 24 h».
 * - The pairing code, the «Copiado» feedback, the BORRAR box and the shortcut being recorded
 *   live in the detail window's local state (fixture-settable). The guardian token, the
 *   diagnostics text and the CSV path never reach this renderer.
 *
 * Results are announced from regions that exist before they arrive (`index.tsx`): each area's
 * notice slot. A result already on screen elsewhere (the new pairing code, «Copiado» in the
 * «Diagnóstico» description, a setting that applied) is a `spokenOnly` notice. `seq` makes a
 * repeated result speak again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePreference } from '@centrate/shared/design/tokens';
import type { GuardianSettings, PunishmentLevel } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS, type SettingsResponse } from '@centrate/shared/guardian-api';
import type { LanguagePreference } from '../../../../shared/i18n/locale';
import { formatInt } from '../../../../shared/format';
import type { UpdaterState } from '../../../../shared/platform';
import type { AmbientSound, ShortcutAction } from '../../../../shared/prefs';
import { newIntentId } from '../../app/push';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { CsvExportKind } from '../../../../shared/stats';
import type { GuideId } from '../../../../shared/ipc';
import type {
  AjustesLocalState,
  CommandResult,
  DefaultBlockMode,
  UiError,
  UiPrefsPatch,
} from '../../../../shared/ui-state';
import { AJUSTES } from './i18n';
import { acceleratorLabel, shortcutTakenBy } from './shortcuts';
import { deleteWordOk, deriveAjustesView, inLabel, isWeakening, type AjustesView } from './view';

export interface AjustesNotice {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
  /** Only for screen readers (the result is already on screen: a new pairing code). */
  spokenOnly?: boolean;
  /** Changes on every notice, so the same sentence twice is announced twice. */
  seq: number;
}

type NewNotice = Omit<AjustesNotice, 'seq'>;

export type AjustesArea =
  'general' | 'shortcuts' | 'bloqueo' | 'study' | 'pairing' | 'sistema' | 'diagnostics' | 'datos';

/** Busy markers: a notice area, or one control that waits for its answer. */
export type AjustesBusy = AjustesArea | 'updater' | 'activewin' | 'export';

export interface AjustesApi {
  view: AjustesView;
  deleteWord: string;
  busy: ReadonlySet<AjustesBusy>;
  notices: Partial<Record<AjustesArea, AjustesNotice>>;
  /** A read of the guardian settings is in flight (e2e and captures wait for it). */
  loading: boolean;
  setTheme(theme: ThemePreference): void;
  setLanguage(language: LanguagePreference): void;
  setAutostart(on: boolean): void;
  setDailyGoal(minutes: number): void;
  setAmbient(sound: AmbientSound): void;
  setVolume(volume: number): void;
  setAutoplay(on: boolean): void;
  setOsd(on: boolean): void;
  /** Start or stop recording a shortcut (`null`: stop). */
  setCapturing(action: ShortcutAction | null): void;
  /** Save a combination (`null` removes it). */
  setShortcut(action: ShortcutAction, accelerator: string | null): void;
  /** A key that cannot be a shortcut («Usa Ctrl o Alt con una tecla»). */
  shortcutHint(text: string): void;
  setDefaultMode(mode: DefaultBlockMode): void;
  setPenalties(on: boolean): void;
  setCloseBrowsers(on: boolean): void;
  setReminders(on: boolean): void;
  setEyeBreaks(on: boolean): void;
  setPunishmentLevel(level: PunishmentLevel): void;
  setPunishmentMinutes(minutes: number): void;
  newPairingCode(): void;
  copyDiagnostics(): void;
  openGuide(guide: GuideId): void;
  requestScreenPermission(): void;
  updaterAction(kind: 'check' | 'download' | 'install'): void;
  restartOnboarding(): void;
  exportCsv(kind: CsvExportKind): void;
  setDeleteWord(text: string): void;
  deleteData(): void;
}

/** The guardian settings a change would send (always the whole object, `settings:put`). */
function withChange(
  settings: GuardianSettings,
  patch: Partial<GuardianSettings>,
): GuardianSettings {
  return structuredClone({ ...settings, ...patch });
}

export function useAjustes(): AjustesApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const env = useAppStore((s) => s.env);
  const detail = useAppStore((s) => s.detail);
  const visible = env.visible;
  const request = env.detail;
  const hasPairing = detail.ajustes.pairing !== null;
  const nowMs = useNow(hasPairing ? 1_000 : 60_000);

  const [busy, setBusy] = useState<ReadonlySet<AjustesBusy>>(() => new Set());
  const [notices, setNotices] = useState<Partial<Record<AjustesArea, AjustesNotice>>>({});
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<UiError | null>(null);
  const [reads, setReads] = useState(0);
  /** A newer updater answer than the snapshot's, until the snapshot's updater changes. */
  const [updaterAnswer, setUpdaterAnswer] = useState<{
    base: UpdaterState;
    value: UpdaterState;
  } | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  const deleteIntent = useRef<string | null>(null);
  /** Orders settings reads and writes: only the latest answer is kept. */
  const settingsSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const notify = useCallback((area: AjustesArea, notice: NewNotice | null) => {
    if (!mounted.current) return;
    const stamped = notice ? { ...notice, seq: (seq.current += 1) } : null;
    setNotices((current) => {
      if (!stamped && !current[area]) return current;
      const next = { ...current };
      if (stamped) next[area] = stamped;
      else delete next[area];
      return next;
    });
  }, []);

  const setBusyArea = useCallback((area: AjustesBusy, on: boolean) => {
    if (!mounted.current) return;
    setBusy((current) => {
      if (current.has(area) === on) return current;
      const next = new Set(current);
      if (on) next.add(area);
      else next.delete(area);
      return next;
    });
  }, []);

  const updateLocal = useCallback(
    (fn: (local: AjustesLocalState) => AjustesLocalState) =>
      api.getState().updateDetail((d) => {
        const next = fn(d.ajustes);
        return next === d.ajustes ? d : { ...d, ajustes: next };
      }),
    [api],
  );

  // The guardian settings: read while visible, again when what they show may have changed.
  const guardianState = snapshot.state;
  const settingsKey = [
    snapshot.link.status,
    guardianState ? JSON.stringify(guardianState.pendingSettings) : 'none',
    guardianState?.points.today.goalMinutes ?? '',
  ].join('|');
  useEffect(() => {
    if (!visible) return undefined;
    const mine = (settingsSeq.current += 1);
    setReads((n) => n + 1);
    const done = (): void => {
      if (mounted.current) setReads((n) => Math.max(0, n - 1));
    };
    void bridge.invoke('settings:get', null).then(
      (result) => {
        done();
        if (!mounted.current || mine !== settingsSeq.current) return;
        if (result.ok) {
          setSettings(result.value);
          setSettingsError(null);
        } else {
          setSettingsError(result.error);
        }
      },
      () => done(),
    );
    return undefined;
  }, [bridge, visible, request, settingsKey]);

  // The updater answer is dropped as soon as main publishes a newer updater state.
  const updaterBase = snapshot.updater;
  const updater =
    updaterAnswer && updaterAnswer.base === updaterBase ? updaterAnswer.value : undefined;

  const view = useMemo(
    () =>
      deriveAjustesView({ env, snapshot, main: api.getState().main, detail }, nowMs, settings, {
        settingsError: settingsError ? errorCopy(settingsError).text : null,
        updater,
      }),
    [api, env, snapshot, detail, nowMs, settings, settingsError, updater],
  );

  const setPrefs = useCallback(
    (area: AjustesArea, patch: UiPrefsPatch, spoken?: string) => {
      notify(area, null);
      void bridge.invoke('prefs:set', patch).then(
        (result) => {
          if (!result.ok) notify(area, { text: AJUSTES.saveFailed, tone: 'red' });
          else if (spoken) notify(area, { text: spoken, tone: 'muted', spokenOnly: true });
        },
        () => notify(area, { text: AJUSTES.saveFailed, tone: 'red' }),
      );
    },
    [bridge, notify],
  );

  /** `settings:put` with one change; says «Se aplicará en 24 h» when it weakens protection. */
  const putSettings = useCallback(
    (area: AjustesArea, patch: Partial<GuardianSettings>, spoken?: string) => {
      if (!settings || busy.has(area)) return;
      const before = settings.settings;
      const next = withChange(before, patch);
      const fields = Object.keys(patch) as (keyof GuardianSettings)[];
      const weakening = fields.some((field) => isWeakening(field, before[field], next[field]));
      // Asking for the value in force again cancels its pending change.
      const cancels = fields.some(
        (field) =>
          settings.pending.some((p) => p.field === field) &&
          JSON.stringify(next[field]) === JSON.stringify(before[field]),
      );
      const mine = (settingsSeq.current += 1);
      setBusyArea(area, true);
      notify(area, null);
      const fail = (error: UiError | null): void => {
        setBusyArea(area, false);
        notify(area, { text: error ? errorCopy(error).text : AJUSTES.saveFailed, tone: 'red' });
      };
      void bridge.invoke('settings:put', { settings: next }).then(
        (result: CommandResult<SettingsResponse>) => {
          if (!result.ok) {
            fail(result.error);
            return;
          }
          setBusyArea(area, false);
          if (mounted.current && mine === settingsSeq.current) {
            setSettings(result.value);
            setSettingsError(null);
          }
          const waits = weakening && result.value.pending.length > 0;
          notify(
            area,
            waits
              ? {
                  text: AJUSTES.pending.weakened(inLabel(GUARDIAN_LIMITS.settingsWeakeningDelayMs)),
                  tone: 'orange',
                }
              : {
                  text: spoken ?? (cancels ? AJUSTES.pending.cancelled : AJUSTES.pending.applied),
                  tone: 'muted',
                  spokenOnly: true,
                },
          );
        },
        () => fail(null),
      );
    },
    [bridge, busy, notify, setBusyArea, settings],
  );

  const shortcuts = snapshot.prefs.shortcuts;
  const platform = snapshot.app.platform;

  return {
    view,
    deleteWord: detail.ajustes.deleteWord,
    busy,
    notices,
    loading: reads > 0,
    setTheme: (theme) => {
      if (theme !== snapshot.prefs.theme) setPrefs('general', { theme });
    },
    setLanguage: (language) => {
      if (language !== snapshot.prefs.language) setPrefs('general', { language });
    },
    setAutostart: (autostart) => setPrefs('general', { autostart }),
    setDailyGoal: (minutes) => {
      if (!settings) return;
      const pendingGoal = settings.pending.find((p) => p.field === 'dailyGoalMinutes');
      const effective = settings.settings.dailyGoalMinutes;
      // The goal in force again cancels a pending lower one (same value, sent anyway).
      if (minutes === effective && !pendingGoal) return;
      if (pendingGoal && pendingGoal.value === minutes) return;
      putSettings('general', { dailyGoalMinutes: minutes });
    },
    setAmbient: (ambient) => {
      if (ambient !== snapshot.prefs.sounds.ambient) setPrefs('general', { sounds: { ambient } });
    },
    setVolume: (volume) => {
      if (volume !== snapshot.prefs.sounds.volume) setPrefs('general', { sounds: { volume } });
    },
    setAutoplay: (autoplay) => setPrefs('general', { sounds: { autoplay } }),
    setOsd: (osd) => setPrefs('general', { osd }),
    setCapturing: (action) => {
      updateLocal((l) => (l.capturing === action ? l : { ...l, capturing: action }));
      if (action !== null) notify('shortcuts', null);
    },
    setShortcut: (action, accelerator) => {
      if (accelerator !== null) {
        const other = shortcutTakenBy(shortcuts, action, accelerator);
        if (other) {
          notify('shortcuts', {
            text: AJUSTES.shortcuts.taken(AJUSTES.shortcuts.titles[other]),
            tone: 'red',
          });
          return;
        }
      }
      updateLocal((l) => (l.capturing === null ? l : { ...l, capturing: null }));
      if (shortcuts[action] === accelerator) return;
      setPrefs(
        'shortcuts',
        { shortcuts: { [action]: accelerator } },
        accelerator === null
          ? AJUSTES.shortcuts.cleared
          : AJUSTES.shortcuts.saved(acceleratorLabel(accelerator, platform)),
      );
    },
    shortcutHint: (text) => notify('shortcuts', { text, tone: 'orange' }),
    setDefaultMode: (defaultMode) => {
      if (defaultMode !== snapshot.prefs.defaultMode) setPrefs('bloqueo', { defaultMode });
    },
    setPenalties: (on) => putSettings('bloqueo', { attemptPenalties: on }),
    setCloseBrowsers: (on) => putSettings('bloqueo', { closeBrowsersWithoutExtension: on }),
    setReminders: (on) => setPrefs('bloqueo', { reminders: { schedules: on } }),
    setEyeBreaks: (on) => setPrefs('bloqueo', { reminders: { eyeBreaks: on } }),
    setPunishmentLevel: (level) => {
      if (!settings || settings.settings.punishment.level === level) return;
      putSettings(
        'study',
        { punishment: { ...settings.settings.punishment, level } },
        AJUSTES.study.saved(AJUSTES.study.levels[level]),
      );
    },
    setPunishmentMinutes: (minutes) => {
      if (!settings || settings.settings.punishment.minutes === minutes) return;
      putSettings(
        'study',
        { punishment: { ...settings.settings.punishment, minutes } },
        AJUSTES.study.durationSaved(formatInt(minutes)),
      );
    },
    newPairingCode: () => {
      if (busy.has('pairing')) return;
      setBusyArea('pairing', true);
      notify('pairing', null);
      void bridge.invoke('pairing:new-code', null).then(
        (result) => {
          setBusyArea('pairing', false);
          if (!result.ok) {
            notify('pairing', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          updateLocal((l) => ({ ...l, pairing: result.value }));
          const minutes = Math.max(
            1,
            Math.round((Date.parse(result.value.expiresAt) - nowMs) / 60_000),
          );
          notify('pairing', {
            text: AJUSTES.sistema.pairingSpoken(result.value.code.split('').join(' '), minutes),
            tone: 'muted',
            spokenOnly: true,
          });
        },
        () => setBusyArea('pairing', false),
      );
    },
    copyDiagnostics: () => {
      if (busy.has('diagnostics')) return;
      setBusyArea('diagnostics', true);
      notify('diagnostics', null);
      void bridge.invoke('diagnostics:copy', null).then(
        (result) => {
          setBusyArea('diagnostics', false);
          if (!result.ok) {
            notify('diagnostics', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          updateLocal((l) => ({ ...l, diagnostics: result.value.source }));
          notify('diagnostics', {
            text: AJUSTES.sistema.diagnosticsSpoken[result.value.source],
            tone: 'muted',
            spokenOnly: true,
          });
        },
        () => setBusyArea('diagnostics', false),
      );
    },
    openGuide: (guide) => bridge.send('app:open-guide', { guide }),
    requestScreenPermission: () => {
      if (busy.has('activewin')) return;
      setBusyArea('activewin', true);
      notify('sistema', null);
      void bridge.invoke('activewin:request-permission', null).then(
        (result) => {
          setBusyArea('activewin', false);
          if (!result.ok) {
            notify('sistema', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          const outcome = result.value.outcome;
          notify('sistema', {
            text: AJUSTES.sistema.activeWindow.outcome[outcome],
            tone: outcome === 'granted' ? 'green' : 'muted',
          });
        },
        () => setBusyArea('activewin', false),
      );
    },
    updaterAction: (kind) => {
      if (busy.has('updater')) return;
      const channel =
        kind === 'check'
          ? 'updater:check'
          : kind === 'download'
            ? 'updater:download'
            : 'updater:install';
      const base = snapshot.updater;
      setBusyArea('updater', true);
      notify('sistema', null);
      void bridge.invoke(channel, null).then(
        (result) => {
          setBusyArea('updater', false);
          if (!result.ok) {
            notify('sistema', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          if (mounted.current) setUpdaterAnswer({ base, value: result.value });
        },
        () => setBusyArea('updater', false),
      );
    },
    restartOnboarding: () => {
      notify('sistema', null);
      void bridge.invoke('prefs:set', { onboarding: { done: false, step: 'welcome' } }).then(
        (result) => {
          if (!result.ok) {
            notify('sistema', { text: AJUSTES.saveFailed, tone: 'red' });
            return;
          }
          // The main window shows the first steps now; this window gets out of the way.
          bridge.send('window:close-detail', null);
        },
        () => notify('sistema', { text: AJUSTES.saveFailed, tone: 'red' }),
      );
    },
    exportCsv: (kind) => {
      if (busy.has('export')) return;
      setBusyArea('export', true);
      notify('datos', null);
      void bridge.invoke('stats:export-csv', { kind }).then(
        (result) => {
          setBusyArea('export', false);
          if (!result.ok) {
            notify('datos', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          const { outcome, fileName, rows } = result.value;
          notify(
            'datos',
            outcome === 'saved' && fileName
              ? { text: AJUSTES.datos.exported(fileName, rows), tone: 'green' }
              : { text: AJUSTES.datos.exportCancelled, tone: 'muted' },
          );
        },
        () => setBusyArea('export', false),
      );
    },
    setDeleteWord: (text) => {
      notify('datos', null);
      updateLocal((l) => (l.deleteWord === text ? l : { ...l, deleteWord: text }));
    },
    deleteData: () => {
      const word = api.getState().detail.ajustes.deleteWord;
      if (!deleteWordOk(word) || busy.has('datos')) return;
      deleteIntent.current ??= newIntentId();
      setBusyArea('datos', true);
      notify('datos', null);
      void bridge.invoke('data:delete', { intentId: deleteIntent.current, confirm: word }).then(
        (result) => {
          setBusyArea('datos', false);
          if (!result.ok) {
            notify('datos', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          deleteIntent.current = null;
          updateLocal((l) => ({ ...l, deleteWord: '' }));
          const kept = result.value.keptBlockIds.length;
          notify('datos', {
            text: kept > 0 ? AJUSTES.datos.deletedKept(kept) : AJUSTES.datos.deleted,
            tone: 'green',
          });
        },
        () => setBusyArea('datos', false),
      );
    },
  };
}
