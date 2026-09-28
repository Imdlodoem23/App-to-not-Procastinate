/**
 * View model of the Ajustes window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle › Ajustes»,
 * the «Extra» of G-Helper; docs/DESKTOP.md §7.7), pure. Four groups of 48 px rows (title and
 * description on the left, the control on the right), everything applied at once:
 *
 * - General: theme Sistema | Claro | Oscuro, language Sistema | Español | English, autostart,
 *   daily goal;
 * - Bloqueo: default mode (and the guardian's own settings when the app can read them);
 * - Sistema: guardian status and «Reparar», each paired extension, the pairing code at 32 px,
 *   the per-browser guides (incognito included) and «Copiar diagnóstico»;
 * - Datos: «Borrar todos mis datos», enabled once BORRAR is typed.
 *
 * Tema and Modo por defecto are rows like the others: three compact tiles on the right, the
 * description on the left saying what the hovered or focused option does. Every tile has an
 * Alt + letter unique in the window (`AJUSTES_KEYS`, `allocateMnemonics` for the guides).
 *
 * Features behind flags (sounds, big notices, CSV export) are hidden, never greyed out.
 * Weakening guardian settings wait 24 h: pending changes say when they apply.
 */
import type { Accent, ThemePreference } from '@centrate/shared/design/tokens';
import type { BrowserFamily, PendingSettingChange, SettingsField } from '@centrate/shared/domain';
import {
  DATA_DELETE_CONFIRM_WORDS,
  DEFAULT_GUARDIAN_PORT,
  GUARDIAN_LIMITS,
  type ExtensionStatus,
  type SettingsResponse,
} from '@centrate/shared/guardian-api';
import { durationLabel } from '@centrate/shared/parser';
import type { GuideId } from '../../../../shared/ipc';
import { formatInt, modeLabel } from '../../../../shared/format';
import {
  modeAccent,
  type DefaultBlockMode,
  type UiSnapshot,
  type UiState,
} from '../../../../shared/ui-state';
import {
  LANGUAGE_PREFERENCES,
  localized,
  type LanguagePreference,
} from '../../../../shared/i18n/locale';
import { RENDERER } from '../../i18n/messages';
import { allocateMnemonics } from '../bloqueos/mnemonics';
import { AJUSTES } from './i18n';

const A = AJUSTES;

/**
 * Alt + letter of the window's fixed tiles (the letter is in the label). The per-browser guides
 * and each extension row's «Guía…» get the free ones (`allocateMnemonics`).
 */
interface AjustesKeys {
  theme: Record<ThemePreference, string>;
  language: Record<LanguagePreference, string>;
  mode: Record<DefaultBlockMode, string>;
  /** «Reparar» or «Instalar». */
  repair: string;
  pairingNew: string;
  diagnostics: string;
  delete: string;
}

/** Per language, so each letter is in its label (read at call time, like the copy). */
export const AJUSTES_KEYS: AjustesKeys = localized<AjustesKeys>({
  es: {
    theme: { system: 's', light: 'c', dark: 'o' },
    language: { system: 't', es: 'l', en: 'g' },
    mode: { normal: 'n', strict: 'e', hardcore: 'h' },
    repair: 'r',
    pairingNew: 'u',
    diagnostics: 'p',
    delete: 'b',
  },
  en: {
    theme: { system: 's', light: 'l', dark: 'k' },
    language: { system: 'y', es: 'p', en: 'e' },
    mode: { normal: 'n', strict: 't', hardcore: 'h' },
    repair: 'r',
    pairingNew: 'w',
    diagnostics: 'c',
    delete: 'd',
  },
});

function fixedAjustesKeys(): string[] {
  const k = AJUSTES_KEYS;
  return [
    ...Object.values(k.theme),
    ...Object.values(k.language),
    ...Object.values(k.mode),
    k.repair,
    k.pairingNew,
    k.diagnostics,
    k.delete,
  ];
}

export const AJUSTES_IDS = {
  general: 'aj-general',
  bloqueo: 'aj-bloqueo',
  sistema: 'aj-sistema',
  datos: 'aj-datos',
  rows: {
    theme: 'aj-theme',
    language: 'aj-language',
    defaultMode: 'aj-default-mode',
    guides: 'aj-guides',
  },
} as const;

export const THEME_OPTIONS: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const LANGUAGE_OPTIONS: readonly LanguagePreference[] = LANGUAGE_PREFERENCES;
export const DEFAULT_MODE_OPTIONS: readonly DefaultBlockMode[] = ['normal', 'strict', 'hardcore'];
export const GUIDES: readonly GuideId[] = [
  'extension-chromium',
  'extension-firefox',
  'extension-incognito',
];

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

/** «en 24 h», «en 3 h», «en 45 min» (hours rounded up from 1 h). */
export function inLabel(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const label =
    minutes >= 60 ? durationLabel(Math.ceil(minutes / 60) * 60) : durationLabel(minutes);
  return A.pending.in(label);
}

/**
 * Whether a guardian settings change weakens protection (then it waits 24 h): a lower daily
 * goal, turning penalties, «cerrar navegadores» or the time check off, a new time zone.
 */
export function isWeakening(field: SettingsField, from: unknown, to: unknown): boolean {
  switch (field) {
    case 'dailyGoalMinutes':
      return typeof from === 'number' && typeof to === 'number' && to < from;
    case 'attemptPenalties':
    case 'closeBrowsersWithoutExtension':
    case 'serverTimeCheck':
      return from === true && to === false;
    case 'timezone':
      return from !== to;
    default:
      return false;
  }
}

/** «Se aplicará en 24 h» for a weakening change, `null` when it applies at once. */
export function weakeningNote(field: SettingsField, from: unknown, to: unknown): string | null {
  return isWeakening(field, from, to)
    ? A.pending.willApply(inLabel(GUARDIAN_LIMITS.settingsWeakeningDelayMs))
    : null;
}

/** What a pending (delayed) change will do and when: «Pasará a 30 min en 23 h». */
export function pendingNote(change: PendingSettingChange, nowMs: number): string {
  const when = inLabel(Date.parse(change.effectiveAt) - nowMs);
  switch (change.field) {
    case 'dailyGoalMinutes':
      return A.pending.goal(formatInt(change.value), when);
    case 'attemptPenalties':
    case 'closeBrowsersWithoutExtension':
    case 'serverTimeCheck':
      return change.value ? A.pending.on(when) : A.pending.off(when);
    default:
      return A.pending.other(when);
  }
}

/**
 * Whether the confirm box allows «Borrar todos mis datos» (trimmed, any case): BORRAR, or
 * DELETE, which the guardian accepts too (the English UI asks for it).
 */
export function deleteWordOk(word: string): boolean {
  return DATA_DELETE_CONFIRM_WORDS.includes(word.trim().toUpperCase());
}

export function guideForBrowser(browser: BrowserFamily): GuideId {
  return browser === 'firefox' ? 'extension-firefox' : 'extension-chromium';
}

// ---------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------

export interface GuardianRowView {
  status: string;
  tone: Accent;
  description: string;
  /** «Reparar» / «Instalar» (hidden while everything works). */
  repair: string | null;
}

export interface ExtensionRowView {
  id: string;
  title: string;
  status: string;
  tone: Accent;
  description: string;
  /** The guide that fixes what is missing (`null` when nothing is). */
  guide: GuideId | null;
  /** Alt + letter of its «Guía…» tile. */
  guideKey?: string | undefined;
}

export type PairingView =
  | { kind: 'none'; expired: boolean }
  | { kind: 'code'; code: string; expiresAtMs: number; port: string | null };

export interface GuardianSettingRowView {
  field: 'closeBrowsersWithoutExtension' | 'attemptPenalties';
  title: string;
  description: string;
  value: boolean;
  /** Pending change or «Se aplicará en 24 h» for switching it off. */
  note: string | null;
}

export interface AjustesView {
  general: {
    title: string;
    theme: ThemePreference;
    themeOptions: { value: ThemePreference; label: string; help: string; mnemonic: string }[];
    language: LanguagePreference;
    languageOptions: {
      value: LanguagePreference;
      label: string;
      help: string;
      mnemonic: string;
    }[];
    autostart: boolean;
    /** `null` while the guardian has not answered. */
    dailyGoal: { value: string; note: string | null } | null;
  };
  bloqueo: {
    title: string;
    defaultMode: DefaultBlockMode;
    modeOptions: {
      value: DefaultBlockMode;
      label: string;
      help: string;
      tone: Accent;
      mnemonic: string;
    }[];
    /** Guardian settings rows; empty until the app can read them (`settings`). */
    guardianSettings: GuardianSettingRowView[];
  };
  sistema: {
    title: string;
    titleTone: 'default' | 'red' | 'orange';
    guardian: GuardianRowView;
    extensions: ExtensionRowView[];
    /** Browsers running without the extension during a block. */
    missing: { id: string; title: string }[];
    pairing: PairingView;
    guides: { id: GuideId; label: string; help: string; mnemonic: string | undefined }[];
    diagnostics: { description: string; tone: 'muted' | 'green' };
  };
  datos: {
    deleteEnabled: boolean;
    deleteHelp: string;
  };
}

function guardianRow(
  snapshot: UiSnapshot,
): GuardianRowView & { key: keyof typeof A.sistema.title } {
  const { link, state, health } = snapshot;
  const S = A.sistema;
  if (link.status === 'connecting') {
    return {
      key: 'connecting',
      status: S.guardianStatus.connecting,
      tone: 'neutral',
      description: S.guardianDesc,
      repair: null,
    };
  }
  if (link.status === 'down') {
    switch (link.reason) {
      case 'not_installed':
        return {
          key: 'notInstalled',
          status: S.guardianStatus.notInstalled,
          tone: 'red',
          description: S.guardianDown,
          repair: S.install,
        };
      case 'unauthorized':
      case 'incompatible':
        return {
          key: 'outdated',
          status: S.guardianStatus.outdated,
          tone: 'red',
          description: S.guardianDown,
          repair: S.repair,
        };
      default:
        return {
          key: 'stopped',
          status: S.guardianStatus.stopped,
          tone: 'red',
          description: S.guardianDown,
          repair: S.repair,
        };
    }
  }
  const parts: string[] = [];
  const version = health?.version ?? state?.guardian.version ?? null;
  if (version) parts.push(S.version(version));
  if (state) {
    parts.push(state.protection.hosts.ok ? S.hostsOk : S.hostsBad);
    parts.push(state.protection.processWatcher.ok ? S.watcherOk : S.watcherBad);
  }
  const description = parts.length > 0 ? parts.join(' · ') : S.guardianDesc;
  if (state && state.guardian.mode !== 'normal') {
    return {
      key: 'problems',
      status: S.guardianStatus.safe,
      tone: 'orange',
      description,
      repair: S.repair,
    };
  }
  if (state && (!state.protection.hosts.ok || !state.protection.processWatcher.ok)) {
    return {
      key: 'problems',
      status: S.guardianStatus.problems,
      tone: 'orange',
      description,
      repair: S.repair,
    };
  }
  return { key: 'ok', status: S.guardianStatus.ok, tone: 'green', description, repair: null };
}

function extensionRow(ext: ExtensionStatus): ExtensionRowView {
  const S = A.sistema;
  const browser = RENDERER.protection.browsers[ext.browser];
  const base = { id: ext.id, title: S.extension(browser) };
  if (!ext.connected) {
    return {
      ...base,
      status: S.extensionStatus.disconnected,
      tone: 'orange',
      description: S.extensionDesc.disconnected,
      guide: guideForBrowser(ext.browser),
    };
  }
  if (!ext.hostPermission) {
    return {
      ...base,
      status: S.extensionStatus.permission,
      tone: 'orange',
      description: S.extensionDesc.permission,
      guide: guideForBrowser(ext.browser),
    };
  }
  if (!ext.incognitoAllowed) {
    return {
      ...base,
      status: S.extensionStatus.incognito,
      tone: 'orange',
      description: S.extensionDesc.incognito,
      guide: 'extension-incognito',
    };
  }
  return {
    ...base,
    status: S.extensionStatus.ok,
    tone: 'green',
    description: S.extensionDesc.ok,
    guide: null,
  };
}

/** The pairing code while it is valid; `expired` once its time passed. */
export function pairingView(
  pairing: UiState['detail']['ajustes']['pairing'],
  nowMs: number,
): PairingView {
  if (!pairing) return { kind: 'none', expired: false };
  const expiresAtMs = Date.parse(pairing.expiresAt);
  if (!(expiresAtMs > nowMs)) return { kind: 'none', expired: true };
  return {
    kind: 'code',
    code: pairing.code,
    expiresAtMs,
    port:
      pairing.port === DEFAULT_GUARDIAN_PORT ? null : A.sistema.pairingPort(String(pairing.port)),
  };
}

function guardianSettingRows(
  settings: SettingsResponse | null,
  pending: readonly PendingSettingChange[],
  nowMs: number,
): GuardianSettingRowView[] {
  if (!settings) return [];
  const rows: GuardianSettingRowView[] = [];
  const B = A.bloqueo;
  const make = (
    field: GuardianSettingRowView['field'],
    title: string,
    description: string,
  ): GuardianSettingRowView => {
    const value = settings.settings[field];
    const change = pending.find((p) => p.field === field);
    return {
      field,
      title,
      description,
      value,
      note: change ? pendingNote(change, nowMs) : weakeningNote(field, value, !value),
    };
  };
  rows.push(make('closeBrowsersWithoutExtension', B.closeBrowsers, B.closeBrowsersDesc));
  rows.push(make('attemptPenalties', B.penalties, B.penaltiesDesc));
  return rows;
}

export function deriveAjustesView(
  state: UiState,
  nowMs: number,
  settings: SettingsResponse | null = null,
): AjustesView {
  const { snapshot } = state;
  const local = state.detail.ajustes;
  const guardianState = snapshot.state;
  const pending = settings?.pending ?? guardianState?.pendingSettings ?? [];
  const guardian = guardianRow(snapshot);

  const goalChange = pending.find((p) => p.field === 'dailyGoalMinutes');
  const goalMinutes =
    settings?.settings.dailyGoalMinutes ?? guardianState?.points.today.goalMinutes;

  const extensions = (guardianState?.protection.extensions ?? []).map(extensionRow);
  const missing = [...new Set(guardianState?.protection.browsersWithoutExtension ?? [])].map(
    (browser) => ({
      id: browser,
      title: A.sistema.browserMissing(RENDERER.protection.browsers[browser]),
    }),
  );
  const extensionTrouble = extensions.some((e) => e.tone !== 'green') || missing.length > 0;
  const sistemaKey = guardian.key === 'ok' && extensionTrouble ? 'extension' : guardian.key;

  // The per-browser guides first (always there), then each extension row's «Guía…».
  const withGuide = extensions.flatMap((e, i) => (e.guide !== null ? [i] : []));
  const listKeys = allocateMnemonics(
    [...GUIDES.map((id) => A.sistema.guides[id]), ...withGuide.map(() => A.sistema.guide)],
    fixedAjustesKeys(),
  );
  const guideKeys = new Map(withGuide.map((row, i) => [row, listKeys[GUIDES.length + i]]));

  return {
    general: {
      title: A.general.title[snapshot.prefs.theme],
      theme: snapshot.prefs.theme,
      themeOptions: THEME_OPTIONS.map((value) => ({
        value,
        label: A.general.themes[value],
        help: A.general.themeHelp[value],
        mnemonic: AJUSTES_KEYS.theme[value],
      })),
      language: snapshot.prefs.language,
      languageOptions: LANGUAGE_OPTIONS.map((value) => ({
        value,
        label: A.general.languages[value],
        help: A.general.languageHelp[value],
        mnemonic: AJUSTES_KEYS.language[value],
      })),
      autostart: snapshot.prefs.autostart,
      dailyGoal:
        goalMinutes === undefined
          ? null
          : {
              value: A.general.dailyGoalValue(formatInt(goalMinutes)),
              note: goalChange ? pendingNote(goalChange, nowMs) : null,
            },
    },
    bloqueo: {
      title: A.bloqueo.title(modeLabel(snapshot.prefs.defaultMode)),
      defaultMode: snapshot.prefs.defaultMode,
      modeOptions: DEFAULT_MODE_OPTIONS.map((value) => ({
        value,
        label: modeLabel(value),
        help: A.bloqueo.modeHelp[value],
        tone: modeAccent(value),
        mnemonic: AJUSTES_KEYS.mode[value],
      })),
      guardianSettings: guardianSettingRows(settings, pending, nowMs),
    },
    sistema: {
      title: A.sistema.title[sistemaKey],
      titleTone:
        guardian.tone === 'red'
          ? 'red'
          : sistemaKey === 'ok' || sistemaKey === 'connecting'
            ? 'default'
            : 'orange',
      guardian: {
        status: guardian.status,
        tone: guardian.tone,
        description: guardian.description,
        repair: guardian.repair,
      },
      extensions: extensions.map((e, i) =>
        e.guide === null ? e : { ...e, guideKey: guideKeys.get(i) },
      ),
      missing,
      pairing: pairingView(local.pairing, nowMs),
      guides: GUIDES.map((id, i) => ({
        id,
        label: A.sistema.guides[id],
        help: A.sistema.guidesHelp[id],
        mnemonic: listKeys[i],
      })),
      diagnostics:
        local.diagnostics === 'guardian'
          ? { description: A.sistema.diagnosticsCopied, tone: 'green' }
          : local.diagnostics === 'fallback'
            ? { description: A.sistema.diagnosticsFallback, tone: 'green' }
            : { description: A.sistema.diagnosticsDesc, tone: 'muted' },
    },
    datos: {
      deleteEnabled: deleteWordOk(local.deleteWord),
      deleteHelp: deleteWordOk(local.deleteWord) ? A.datos.deleteDesc : A.datos.deleteNeedsWord,
    },
  };
}
