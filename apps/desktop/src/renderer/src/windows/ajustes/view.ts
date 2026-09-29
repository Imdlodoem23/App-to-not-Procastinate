/**
 * View model of the Ajustes window (PROMPT §9 «Ajustes», §10 «Ventanas de detalle › Ajustes»,
 * the «Extra» of G-Helper; docs/DESKTOP.md §7.7, §15), pure. Groups of 48 px rows (title and
 * description on the left, the control on the right), everything applied at once:
 *
 * - General: language, theme, autostart, daily goal, concentration sound (volume, play during
 *   blocks), big notices (OSD) and the global shortcuts;
 * - Bloqueo: default mode, penalties (and the read-only list of what costs points), «cerrar
 *   navegadores sin extensión», the schedule reminders and the 20-20-20 rule;
 * - Study Mode: here before its wave. Only the punishment level works (it is a guardian setting
 *   and applies at once); the camera settings say they arrive with Study Mode;
 * - Sistema: guardian, each paired extension, the pairing code at 32 px, the per-browser guides
 *   (incognito included), the active-window layer (macOS Screen Recording), the camera, updates,
 *   the first steps again and «Copiar diagnóstico»;
 * - Datos: «Exportar a CSV» and «Borrar todos mis datos», enabled once BORRAR is typed.
 *
 * The guardian's own settings (goal, penalties, «cerrar navegadores», punishment) come from
 * `settings:get`; weakening changes wait 24 h (docs/ARCHITECTURE.md §5.8), so pending ones say
 * when they apply and the controls say beforehand which changes will wait.
 *
 * Every tile has an Alt + letter unique in the window (`AJUSTES_KEYS` for the fixed tiles,
 * `allocateMnemonics` for the per-browser guides, «Exportar días» and each extension row's
 * «Guía…»), carried by the view so the tests can check them. Features behind flags (sounds, big
 * notices, reminders, the mini timer shortcut, updates, onboarding, CSV export) are hidden, never
 * greyed out.
 */
import { getService } from '@centrate/shared/catalog';
import type { Accent, ThemePreference } from '@centrate/shared/design/tokens';
import type {
  BrowserFamily,
  PendingSettingChange,
  PunishmentLevel,
  SettingsField,
} from '@centrate/shared/domain';
import {
  DATA_DELETE_CONFIRM_WORDS,
  DEFAULT_GUARDIAN_PORT,
  GUARDIAN_LIMITS,
  type ExtensionStatus,
  type SettingsResponse,
} from '@centrate/shared/guardian-api';
import { durationLabel } from '@centrate/shared/parser';
import {
  POINT_RULES,
  STUDY_RULES,
  attemptPenalty,
  maxEscalationIndex,
} from '@centrate/shared/points';
import type { GuideId } from '../../../../shared/ipc';
import { formatClock, formatInt, formatSignedInt, modeLabel } from '../../../../shared/format';
import type { ActiveWindowState, UpdaterState } from '../../../../shared/platform';
import { SHORTCUT_ACTIONS, type AmbientSound, type ShortcutAction } from '../../../../shared/prefs';
import {
  modeAccent,
  snapshotFeature,
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
import { acceleratorLabel } from './shortcuts';

const A = AJUSTES;

/** «Objetivo diario»: the four goals offered (any other value still shows as the current one). */
export const GOAL_OPTIONS = [30, 45, 60, 90] as const;
export type GoalOption = (typeof GOAL_OPTIONS)[number];

export const PUNISHMENT_OPTIONS: readonly PunishmentLevel[] = [
  'distractions',
  'whitelist',
  'nuclear',
];

/** Armed id of «Nuclear» (in-place «¿Seguro?», PROMPT §10 «activar Nuclear»). */
export const NUCLEAR_ARM_ID = 'punishment-nuclear';

/**
 * Alt + letter of the window's fixed tiles (the letter is in the label where one is free; the
 * sound tile's «Nada» and «Exportar días» have none). The per-browser guides, «Exportar días»
 * and each extension row's «Guía…» get the free ones (`allocateMnemonics`).
 */
interface AjustesKeys {
  theme: Record<ThemePreference, string>;
  language: Record<LanguagePreference, string>;
  goal: Record<GoalOption, string>;
  /** «Sonido: Lluvia» (PLANNER's tile that cycles the sound). */
  sound: string;
  mode: Record<DefaultBlockMode, string>;
  punishment: Record<PunishmentLevel, string>;
  /** «Reparar» or «Instalar». */
  repair: string;
  pairingNew: string;
  /** «Activar…» (macOS Screen Recording). */
  activeWindow: string;
  /** «Comprobar ya», «Descargar ya», «Reiniciar y actualizar». */
  updater: string;
  /** «Empezar de nuevo» (the first steps). */
  onboarding: string;
  diagnostics: string;
  exportEvents: string;
  delete: string;
}

/**
 * Per language, so each letter is in its label (read at call time, like the copy). «Español»
 * and «English» read the same in both languages, so they keep the same letters (Alt+P,
 * Alt+G): someone who switched by mistake switches back with the key they just used.
 */
export const AJUSTES_KEYS: AjustesKeys = localized<AjustesKeys>({
  es: {
    theme: { system: 's', light: 'c', dark: 'o' },
    language: { system: 't', es: 'p', en: 'g' },
    goal: { 30: '3', 45: '4', 60: '6', 90: '9' },
    sound: 'l',
    mode: { normal: 'n', strict: 'e', hardcore: 'h' },
    punishment: { distractions: '1', whitelist: '2', nuclear: 'a' },
    repair: 'r',
    pairingNew: 'u',
    activeWindow: 'v',
    updater: 'y',
    onboarding: 'z',
    diagnostics: 'd',
    exportEvents: 'x',
    delete: 'b',
  },
  en: {
    theme: { system: 's', light: 'l', dark: 'k' },
    language: { system: 'y', es: 'p', en: 'g' },
    goal: { 30: '3', 45: '4', 60: '6', 90: '9' },
    sound: 'u',
    mode: { normal: 'n', strict: 't', hardcore: 'h' },
    punishment: { distractions: '1', whitelist: '2', nuclear: 'e' },
    repair: 'r',
    pairingNew: 'w',
    activeWindow: 'a',
    updater: 'o',
    onboarding: 'b',
    diagnostics: 'c',
    exportEvents: 'x',
    delete: 'd',
  },
});

function fixedAjustesKeys(): string[] {
  const k = AJUSTES_KEYS;
  return [
    ...Object.values(k.theme),
    ...Object.values(k.language),
    ...Object.values(k.goal),
    k.sound,
    ...Object.values(k.mode),
    ...Object.values(k.punishment),
    k.repair,
    k.pairingNew,
    k.activeWindow,
    k.updater,
    k.onboarding,
    k.diagnostics,
    k.exportEvents,
    k.delete,
  ];
}

export const AJUSTES_IDS = {
  general: 'aj-general',
  bloqueo: 'aj-bloqueo',
  study: 'aj-study',
  sistema: 'aj-sistema',
  datos: 'aj-datos',
  rows: {
    theme: 'aj-theme',
    language: 'aj-language',
    goal: 'aj-goal',
    defaultMode: 'aj-default-mode',
    punishment: 'aj-punishment',
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

/**
 * «en 24 h», «en 3 h», «en 45 min» (hours rounded up from 1 h). The minutes are rounded to the
 * nearest one first: the guardian stamps `effectiveAt` to the whole second and the view's clock
 * lags up to a tick, so a change made just now is 24 h plus a moment away and must not read
 * «en 25 h».
 */
export function inLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const label =
    minutes >= 60 ? durationLabel(Math.ceil(minutes / 60) * 60) : durationLabel(minutes);
  return A.pending.in(label);
}

/** «24 h»: how long a weakening change waits. */
export function weakeningDelayLabel(): string {
  return durationLabel(Math.round(GUARDIAN_LIMITS.settingsWeakeningDelayMs / 60_000));
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

/** The shortcut actions Ajustes shows (the mini timer's only with its flag). */
export function shortcutActions(
  snapshot: Pick<UiSnapshot, 'features' | 'health'>,
): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter(
    (action) => action !== 'toggle-mini-timer' || snapshotFeature(snapshot, 'miniTimer'),
  );
}

// ---------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------

export interface ChoiceOptionView<T extends string | number> {
  value: T;
  label: string;
  help: string;
  mnemonic: string;
  tone?: Accent;
}

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
  field: 'attemptPenalties' | 'closeBrowsersWithoutExtension';
  title: string;
  /** What it does now (and, while on, that turning it off waits 24 h). */
  description: string;
  /** What the switch shows: the value asked for (a pending one), else the one in force. */
  value: boolean;
  /** The value in force. */
  effective: boolean;
  /** A pending change of this field, in orange: «Se desactivará en 22 h». */
  note: string | null;
}

export interface GoalView {
  /** «60 min»: the goal in force. */
  value: string;
  /** A pending lower goal: «Pasará a 45 min en 23 h». */
  note: string | null;
  /** The four goals, once the guardian settings were read (`null` before). */
  options: ChoiceOptionView<GoalOption>[] | null;
  /**
   * The option asked for: a pending lower goal, else the one in force (`null` for a goal that
   * is not one of them). The one in force stays pressable while a lower one waits: it cancels it.
   */
  selected: GoalOption | null;
}

export interface ShortcutRowView {
  action: ShortcutAction;
  title: string;
  /** What it does; while recording, how to record; the OS refusal in orange. */
  description: string;
  tone: 'muted' | 'orange';
  /** The combination as the field shows it («Ctrl+Alt+C»), `''` without one. */
  label: string;
  accelerator: string | null;
  capturing: boolean;
}

export interface UpdaterRowView {
  /** «al día», «nueva versión»… (after «Actualizaciones: »). */
  status: string;
  tone: Accent;
  description: string;
  action: {
    kind: 'check' | 'download' | 'install';
    label: string;
    disabled: boolean;
    key: string;
  } | null;
}

export interface AjustesView {
  general: {
    title: string;
    theme: ThemePreference;
    themeOptions: ChoiceOptionView<ThemePreference>[];
    language: LanguagePreference;
    languageOptions: ChoiceOptionView<LanguagePreference>[];
    autostart: boolean;
    /** `null` while the goal is unknown (no guardian state and no settings). */
    dailyGoal: GoalView | null;
    /** `sounds` flag. */
    sounds: {
      ambient: AmbientSound;
      volume: number;
      volumeLabel: string;
      autoplay: boolean;
      key: string;
    } | null;
    /** «Avisos grandes» (`osd` flag). */
    osd: boolean | null;
    shortcuts: ShortcutRowView[];
  };
  bloqueo: {
    title: string;
    defaultMode: DefaultBlockMode;
    modeOptions: ChoiceOptionView<DefaultBlockMode>[];
    /** Guardian settings rows; empty until the app can read them (`settings`). */
    guardianSettings: GuardianSettingRowView[];
    /** While the guardian settings are not there: «Leyendo…» or why (`null` once read). */
    settingsStatus: string | null;
    /** What costs points (read-only). */
    values: { label: string; value: string }[];
    /** `reminders` flag. */
    reminders: { schedules: boolean; schedulesDesc: string; eyeBreaks: boolean } | null;
  };
  study: {
    title: string;
    /** `null` until the guardian settings were read. */
    levels: ChoiceOptionView<PunishmentLevel>[] | null;
    level: PunishmentLevel | null;
    levelDesc: string;
    /** «Nuclear» is chosen: the honest note about administrators shows. */
    nuclear: boolean;
  };
  sistema: {
    title: string;
    titleTone: 'default' | 'red' | 'orange' | 'blue';
    guardian: GuardianRowView;
    repairKey: string;
    extensions: ExtensionRowView[];
    /** Browsers running without the extension during a block. */
    missing: { id: string; title: string }[];
    pairing: PairingView;
    pairingKey: string;
    guides: { id: GuideId; label: string; help: string; mnemonic: string | undefined }[];
    activeWindow: { status: string; tone: Accent; description: string; allowKey: string | null };
    camera: { status: string; description: string };
    /** `updater` flag. */
    updater: UpdaterRowView | null;
    /** «Empezar de nuevo» (`onboarding` flag): its key, or `null` when hidden. */
    onboardingKey: string | null;
    diagnostics: { description: string; tone: 'muted' | 'green' };
    diagnosticsKey: string;
  };
  datos: {
    /** «Exportar eventos» / «Exportar días» (`stats` flag). */
    export: { events: string; days: string | undefined } | null;
    deleteEnabled: boolean;
    deleteHelp: string;
    deleteKey: string;
  };
}

/** Every Alt + letter the window's visible tiles use (tests: unique, one per tile). */
export function ajustesTileKeys(view: AjustesView): (string | undefined)[] {
  const s = view.sistema;
  return [
    ...view.general.languageOptions.map((o) => o.mnemonic),
    ...view.general.themeOptions.map((o) => o.mnemonic),
    ...(view.general.dailyGoal?.options ?? []).map((o) => o.mnemonic),
    ...(view.general.sounds ? [view.general.sounds.key] : []),
    ...view.bloqueo.modeOptions.map((o) => o.mnemonic),
    ...(view.study.levels ?? []).map((o) => o.mnemonic),
    ...(s.guardian.repair ? [s.repairKey] : []),
    ...s.extensions.flatMap((e) => (e.guide ? [e.guideKey] : [])),
    s.pairingKey,
    ...s.guides.map((g) => g.mnemonic),
    ...(s.activeWindow.allowKey ? [s.activeWindow.allowKey] : []),
    ...(s.updater?.action ? [s.updater.action.key] : []),
    ...(s.onboardingKey ? [s.onboardingKey] : []),
    s.diagnosticsKey,
    ...(view.datos.export ? [view.datos.export.events, view.datos.export.days] : []),
    view.datos.deleteKey,
  ];
}

type SistemaTitleKey = keyof typeof A.sistema.title;

function guardianRow(snapshot: UiSnapshot): GuardianRowView & { key: SistemaTitleKey } {
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
  const B = A.bloqueo;
  const delay = weakeningDelayLabel();
  const row = (
    field: GuardianSettingRowView['field'],
    title: string,
    describe: (on: boolean) => string,
  ): GuardianSettingRowView => {
    const effective = settings.settings[field];
    const change = pending.find((p) => p.field === field);
    const requested = change && typeof change.value === 'boolean' ? change.value : null;
    return {
      field,
      title,
      description: describe(effective),
      // The switch shows what was asked for; the note says when it applies. Pressing it
      // again asks for the value in force, which cancels the wait.
      value: requested ?? effective,
      effective,
      note: change ? pendingNote(change, nowMs) : null,
    };
  };
  return [
    row('attemptPenalties', B.penalties, (on) =>
      on ? B.penaltiesOnDesc(delay) : B.penaltiesOffDesc,
    ),
    row('closeBrowsersWithoutExtension', B.closeBrowsers, (on) =>
      on ? B.closeBrowsersOnDesc(delay) : B.closeBrowsersDesc,
    ),
  ];
}

/** «Lo que resta puntos» (read-only, from `POINT_RULES`). */
function penaltyValues(attemptPenalties: boolean): { label: string; value: string }[] {
  const V = A.bloqueo.values;
  const top = maxEscalationIndex();
  const ladder = Array.from({ length: top + 1 }, (_, i) => formatSignedInt(-attemptPenalty(i)));
  const attempt = attemptPenalties
    ? V.attemptValue(
        ladder[0] ?? '',
        ladder.slice(1, -1).join(', '),
        ladder[ladder.length - 1] ?? '',
        formatInt(POINT_RULES.attemptEscalationWindowMs / 60_000),
      )
    : V.attemptOff;
  return [
    { label: V.attempt, value: attempt },
    { label: V.strike, value: formatSignedInt(-POINT_RULES.strikePenalty) },
    { label: V.punishment, value: formatSignedInt(-POINT_RULES.punishmentPenalty) },
    {
      label: V.emergency,
      value: V.emergencyValue(formatSignedInt(-POINT_RULES.emergencyMinPenalty)),
    },
  ];
}

function goalView(
  snapshot: UiSnapshot,
  settings: SettingsResponse | null,
  pending: readonly PendingSettingChange[],
  nowMs: number,
): GoalView | null {
  const effective = settings?.settings.dailyGoalMinutes ?? snapshot.state?.points.today.goalMinutes;
  if (effective === undefined) return null;
  const change = pending.find((p) => p.field === 'dailyGoalMinutes');
  const waiting = change?.field === 'dailyGoalMinutes' ? change : null;
  const G = A.general.goalHelp;
  const help = (value: number): string => {
    if (value === effective) return waiting ? G.cancel : G.current;
    if (waiting && waiting.value === value) {
      return G.pending(inLabel(Date.parse(waiting.effectiveAt) - nowMs));
    }
    return value > effective ? G.raise : G.lower(inLabel(GUARDIAN_LIMITS.settingsWeakeningDelayMs));
  };
  return {
    value: A.general.dailyGoalValue(formatInt(effective)),
    note: waiting ? pendingNote(waiting, nowMs) : null,
    options: settings
      ? GOAL_OPTIONS.map((value) => ({
          value,
          label: A.general.dailyGoalValue(formatInt(value)),
          help: help(value),
          mnemonic: AJUSTES_KEYS.goal[value],
          tone: 'neutral' as const,
        }))
      : null,
    // The goal asked for (a pending lower one), else the one in force.
    selected: (GOAL_OPTIONS as readonly number[]).includes(waiting?.value ?? effective)
      ? ((waiting?.value ?? effective) as GoalOption)
      : null,
  };
}

function shortcutRows(state: UiState): ShortcutRowView[] {
  const { snapshot } = state;
  const S = A.shortcuts;
  const capturing = state.detail.ajustes.capturing;
  const failed = new Set(snapshot.shortcuts.failed);
  return shortcutActions(snapshot).map((action) => {
    const accelerator = snapshot.prefs.shortcuts[action];
    const recording = capturing === action;
    const refused = !recording && accelerator !== null && failed.has(action);
    return {
      action,
      title: S.titles[action],
      description: recording ? S.capturing : refused ? S.failed : S.descs[action],
      tone: refused ? 'orange' : 'muted',
      label: accelerator ? acceleratorLabel(accelerator, snapshot.app.platform) : '',
      accelerator,
      capturing: recording,
    };
  });
}

const ACTIVE_WINDOW_TONES: Readonly<Record<ActiveWindowState, Accent>> = {
  off: 'neutral',
  ok: 'green',
  'needs-permission': 'orange',
  unsupported: 'neutral',
  error: 'orange',
};

function activeWindowRow(snapshot: UiSnapshot): AjustesView['sistema']['activeWindow'] {
  const W = A.sistema.activeWindow;
  const { status, lastMatch } = snapshot.activeWindow;
  const service = lastMatch ? (getService(lastMatch.serviceId)?.name ?? lastMatch.serviceId) : null;
  return {
    status: W.status[status],
    tone: ACTIVE_WINDOW_TONES[status],
    description:
      status === 'ok' && lastMatch && service
        ? W.lastMatch(service, formatClock(lastMatch.at))
        : W.desc[status],
    allowKey: status === 'needs-permission' ? AJUSTES_KEYS.activeWindow : null,
  };
}

/** Ajustes › Sistema «Actualizaciones» (`updater` flag), from the updater state. */
export function updaterRow(updater: UpdaterState, appVersion: string): UpdaterRowView {
  const U = A.sistema.updater;
  const key = AJUSTES_KEYS.updater;
  const next = updater.version ?? appVersion;
  const action = (
    kind: 'check' | 'download' | 'install',
    label: string,
    disabled = false,
  ): UpdaterRowView['action'] => ({ kind, label, disabled, key });
  switch (updater.status) {
    case 'idle':
      return {
        status: U.status.idle,
        tone: 'neutral',
        description: U.current(appVersion),
        action: action('check', U.actions.check),
      };
    case 'checking':
      return {
        status: U.status.checking,
        tone: 'neutral',
        description: U.current(appVersion),
        action: action('check', U.actions.checking, true),
      };
    case 'current':
      return {
        status: U.status.current,
        tone: 'green',
        description:
          updater.checkedAt !== null
            ? U.upToDate(appVersion, formatClock(updater.checkedAt))
            : U.current(appVersion),
        action: action('check', U.actions.check),
      };
    case 'available':
      return {
        status: U.status.available,
        tone: 'blue',
        description: U.available(next, appVersion),
        action: action('download', U.actions.download),
      };
    case 'downloading':
      return {
        status: U.status.downloading,
        tone: 'blue',
        description: U.downloading(next, formatInt(updater.percent ?? 0)),
        action: action('download', U.actions.downloading, true),
      };
    case 'ready':
      return {
        status: U.status.ready,
        tone: 'blue',
        description: U.ready(next),
        action: action('install', U.actions.install),
      };
    case 'error':
      return {
        status: U.status.error,
        tone: 'orange',
        description: U.error,
        action: action('check', U.actions.check),
      };
    case 'unsupported':
      return {
        status: U.status.unsupported,
        tone: 'neutral',
        description: U.unsupported,
        action: null,
      };
  }
}

export interface AjustesViewOptions {
  /** `settings:get` failed: why, for the rows that need the guardian settings. */
  settingsError?: string | null;
  /** The updater state to show (the snapshot's, or a newer answer of an updater call). */
  updater?: UpdaterState;
}

export function deriveAjustesView(
  state: UiState,
  nowMs: number,
  settings: SettingsResponse | null = null,
  options: AjustesViewOptions = {},
): AjustesView {
  const { snapshot } = state;
  const local = state.detail.ajustes;
  const guardianState = snapshot.state;
  const pending = settings?.pending ?? guardianState?.pendingSettings ?? [];
  const guardian = guardianRow(snapshot);
  const feature = (name: Parameters<typeof snapshotFeature>[1]): boolean =>
    snapshotFeature(snapshot, name);

  const extensions = (guardianState?.protection.extensions ?? []).map(extensionRow);
  const missing = [...new Set(guardianState?.protection.browsersWithoutExtension ?? [])].map(
    (browser) => ({
      id: browser,
      title: A.sistema.browserMissing(RENDERER.protection.browsers[browser]),
    }),
  );
  const extensionTrouble = extensions.some((e) => e.tone !== 'green') || missing.length > 0;
  const updater = feature('updater') ? (options.updater ?? snapshot.updater) : null;
  const updateWaiting = updater?.status === 'available' || updater?.status === 'ready';
  const sistemaKey: SistemaTitleKey =
    guardian.key !== 'ok'
      ? guardian.key
      : extensionTrouble
        ? 'extension'
        : updateWaiting
          ? 'update'
          : 'ok';

  // The per-browser guides first (always there), then «Exportar días», then each extension
  // row's «Guía…» (their number varies, so they come last and move nothing else).
  const exportShown = feature('stats');
  const withGuide = extensions.flatMap((e, i) => (e.guide !== null ? [i] : []));
  const listKeys = allocateMnemonics(
    [
      ...GUIDES.map((id) => A.sistema.guides[id]),
      A.datos.exportDays,
      ...withGuide.map(() => A.sistema.guide),
    ],
    fixedAjustesKeys(),
  );
  const exportDaysKey = listKeys[GUIDES.length];
  const guideKeys = new Map(withGuide.map((row, i) => [row, listKeys[GUIDES.length + 1 + i]]));

  const policy = settings?.settings.punishment ?? null;
  const settingsStatus = settings
    ? null
    : (options.settingsError ?? A.bloqueo.guardianSettingsLoading);

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
      dailyGoal: goalView(snapshot, settings, pending, nowMs),
      sounds: feature('sounds')
        ? {
            ambient: snapshot.prefs.sounds.ambient,
            volume: snapshot.prefs.sounds.volume,
            volumeLabel: A.general.volumeValue(formatInt(snapshot.prefs.sounds.volume)),
            autoplay: snapshot.prefs.sounds.autoplay,
            key: AJUSTES_KEYS.sound,
          }
        : null,
      osd: feature('osd') ? snapshot.prefs.osd : null,
      shortcuts: shortcutRows(state),
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
      settingsStatus,
      values: penaltyValues(settings?.settings.attemptPenalties ?? true),
      reminders: feature('reminders')
        ? {
            schedules: snapshot.prefs.reminders.schedules,
            schedulesDesc: A.bloqueo.remindersDesc(snapshot.prefs.reminders.leadMinutes),
            eyeBreaks: snapshot.prefs.reminders.eyeBreaks,
          }
        : null,
    },
    study: {
      title: feature('study') ? A.study.title.ready : A.study.title.soon,
      levels: policy
        ? PUNISHMENT_OPTIONS.map((value) => ({
            value,
            label: A.study.levels[value],
            help: A.study.levelHelp[value],
            tone: value === 'nuclear' ? ('red' as const) : ('orange' as const),
            mnemonic: AJUSTES_KEYS.punishment[value],
          }))
        : null,
      level: policy?.level ?? null,
      levelDesc: policy
        ? A.study.levelDesc(STUDY_RULES.maxStrikes, formatInt(policy.minutes))
        : (settingsStatus ?? ''),
      nuclear: policy?.level === 'nuclear',
    },
    sistema: {
      title: A.sistema.title[sistemaKey],
      titleTone:
        guardian.tone === 'red'
          ? 'red'
          : sistemaKey === 'ok' || sistemaKey === 'connecting'
            ? 'default'
            : sistemaKey === 'update'
              ? 'blue'
              : 'orange',
      guardian: {
        status: guardian.status,
        tone: guardian.tone,
        description: guardian.description,
        repair: guardian.repair,
      },
      repairKey: AJUSTES_KEYS.repair,
      extensions: extensions.map((e, i) =>
        e.guide === null ? e : { ...e, guideKey: guideKeys.get(i) },
      ),
      missing,
      pairing: pairingView(local.pairing, nowMs),
      pairingKey: AJUSTES_KEYS.pairingNew,
      guides: GUIDES.map((id, i) => ({
        id,
        label: A.sistema.guides[id],
        help: A.sistema.guidesHelp[id],
        mnemonic: listKeys[i],
      })),
      activeWindow: activeWindowRow(snapshot),
      camera: { status: A.sistema.camera.status, description: A.sistema.camera.desc },
      updater: updater ? updaterRow(updater, snapshot.app.version) : null,
      onboardingKey: feature('onboarding') ? AJUSTES_KEYS.onboarding : null,
      diagnostics:
        local.diagnostics === 'guardian'
          ? { description: A.sistema.diagnosticsCopied, tone: 'green' }
          : local.diagnostics === 'fallback'
            ? { description: A.sistema.diagnosticsFallback, tone: 'green' }
            : { description: A.sistema.diagnosticsDesc, tone: 'muted' },
      diagnosticsKey: AJUSTES_KEYS.diagnostics,
    },
    datos: {
      export: exportShown ? { events: AJUSTES_KEYS.exportEvents, days: exportDaysKey } : null,
      deleteEnabled: deleteWordOk(local.deleteWord),
      deleteHelp: deleteWordOk(local.deleteWord) ? A.datos.deleteDesc : A.datos.deleteNeedsWord,
      deleteKey: AJUSTES_KEYS.delete,
    },
  };
}
