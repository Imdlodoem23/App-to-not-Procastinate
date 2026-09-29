/**
 * View model of the Bloqueos window (PROMPT §4 «Formulario avanzado», §9, §10 «Ventanas de
 * detalle › Bloqueos»; docs/DESKTOP.md §7.7), pure. Sections, top to bottom:
 *
 * 1. the advanced form in two columns, one section per decision with the title as its state:
 *    «Qué bloquear: YouTube +1» on the left; «Duración: 1 h» · «hasta 18:00», «Modo: Estricto»
 *    and «Tu motivo» on the right; then «Guardar como plantilla | Bloquear…» (the draft goes to
 *    the main window's card, the one confirmation path);
 * 2. «Activos» (from the snapshot), «Plantillas», «Horarios» (fetched when the window opens:
 *    one row per schedule with «Editar» and a switch, then «Nuevo horario» or the editor in
 *    place) and «Modo examen» (whitelist + Hardcore, with the user's whitelist extras from the
 *    guardian's settings).
 *
 * Nothing is invented (PROMPT §4): opened from a phrase whose time was not understood, the
 * duration stays «sin elegir» and «Bloquear…» says «Elige cuánto dura» until the user picks one.
 *
 * Every tile has an Alt + letter unique in the window (`BLOQUEOS_KEYS`, `allocateMnemonics`).
 * Components map this to the UI kit; everything a screenshot shows is derived here.
 */
import { STUDY_WHITELIST, studySiteName } from '@centrate/shared/catalog';
import type { Accent } from '@centrate/shared/design/tokens';
import {
  BLOCK_MODES,
  LIMIT_MODES,
  type BlockMode,
  type DailyLimit,
  type IsoWeekday,
  type LimitMode,
  type Schedule,
} from '@centrate/shared/domain';
import type { CategoryId } from '@centrate/shared/catalog';
import { durationLabel } from '@centrate/shared/parser';
import { modeLabel, targetsLabel } from '../../../../shared/format';
import {
  draftProblem,
  modeAccent,
  type BlockDraft,
  templateLabel,
  type DraftProblem,
  type UiError,
  type UiState,
} from '../../../../shared/ui-state';
import {
  appSuggestions,
  catalogGroups,
  customEntries,
  searchCatalog,
  selectedCount,
  toCatalogPlatform,
  type AppSuggestion,
  type CatalogGroup,
  type CatalogSearch,
  type EntryView,
} from './catalog';
import { DURATION_PRESETS, durationFields, selectedPreset, type DurationFields } from './duration';
import { activeLocale, localized } from '../../../../shared/i18n/locale';
import { BLOQUEOS } from './i18n';
import { allocateMnemonics } from './mnemonics';
import {
  ISO_WEEKDAYS,
  formAddsTargets,
  scheduleAutoName,
  scheduleChips,
  scheduleCategories,
  scheduleDeleteLock,
  scheduleErrorText,
  scheduleNeedsConsequence,
  scheduleProblem,
  scheduleProblemText,
  scheduleWindowLabel,
  type ScheduleChip,
} from './schedule-editor';
import {
  isWhitelistSchedule,
  scheduleRow,
  scheduleSummary,
  type ScheduleRowView,
} from './schedules';
import {
  editorMinutes,
  limitEditWeakens,
  limitEditorProblem,
  limitEditorProblemText,
  limitErrorText,
  limitRow,
  limitSummary,
  mergeLimits,
  pendingEstimate,
  type LimitRowView,
  type LimitsData,
} from './limits';
import {
  LIMIT_TEXT,
  limitAutoName,
  limitNeedsConsequence,
  limitReachedToday,
  limitsSupported,
} from '../../../../shared/limits';
import { untilPhrase, whenLabel } from './time';
import {
  whitelistLists,
  whitelistSuggestions,
  whitelistView,
  type SettingsData,
  type WhitelistView,
} from './whitelist';

const E = BLOQUEOS;

/** Ids of the window's sections (scroll targets of `DetailRequest.focus`) and rows. */
export const BLOQUEOS_IDS = {
  targets: 'blq-targets',
  duration: 'blq-duration',
  mode: 'blq-mode',
  reason: 'blq-reason',
  active: 'blq-active',
  templates: 'blq-templates',
  schedules: 'blq-schedules',
  limits: 'blq-limits',
  exam: 'blq-exam',
  search: 'blq-search',
  /** The schedule editor (a group inside «Horarios») and its name field. */
  scheduleEditor: 'blq-schedule-editor',
  scheduleName: 'blq-schedule-name',
  newSchedule: 'blq-new-schedule',
  /** The daily-limit editor (a group inside «Límites diarios») and its fields. */
  limitEditor: 'blq-limit-editor',
  limitName: 'blq-limit-name',
  limitMinutes: 'blq-limit-minutes',
  newLimit: 'blq-new-limit',
  /** «Límites diarios» of a guardian without them: the note that says why. */
  limitsUnsupported: 'blq-limits-unsupported',
  whitelist: 'blq-whitelist',
  whitelistDomain: 'blq-whitelist-domain',
  rows: {
    presets: 'blq-presets',
    modes: 'blq-modes',
    actions: 'blq-actions',
    naming: 'blq-naming',
    exam: 'blq-exam-row',
    newSchedule: 'blq-new-schedule-row',
    scheduleModes: 'blq-schedule-modes',
    scheduleActions: 'blq-schedule-actions',
    newLimit: 'blq-new-limit-row',
    limitModes: 'blq-limit-modes',
    limitActions: 'blq-limit-actions',
  },
} as const;

/**
 * Alt + letter of the window's fixed tiles (the letter sits in the label, so it is underlined
 * while Alt is held). Exam presets and template rows get the free ones (`allocateMnemonics`).
 */
interface BloqueosKeys {
  addDomain: string;
  addApp: string;
  /** «30 min | 1 h | 2 h | 3 h». */
  presets: Readonly<Record<number, string>>;
  modes: Readonly<Record<BlockMode, string>>;
  save: string;
  block: string;
  /** The naming row replaces «Guardar como plantilla | Bloquear…»: «Guardar | Cancelar». */
  saveName: string;
  cancelName: string;
  customize: string;
  /** «Nuevo horario» (hidden while the editor is open). */
  newSchedule: string;
  /** «Nuevo límite» (hidden while its editor is open). */
  newLimit: string;
  /** «Permitir» next to the whitelist's web and app fields. */
  allowDomain: string;
  allowApp: string;
}

/** Per language, read at call time like the copy. */
export const BLOQUEOS_KEYS: BloqueosKeys = localized<BloqueosKeys>({
  es: {
    addDomain: 'd',
    addApp: 'a',
    presets: { 30: 'm', 60: '1', 120: '2', 180: '3' },
    modes: { normal: 'n', strict: 'e', hardcore: 'h', exam: 'x' },
    save: 'g',
    block: 'b',
    saveName: 'g',
    cancelName: 'c',
    customize: 'p',
    newSchedule: 'o',
    newLimit: 'l',
    allowDomain: 'i',
    allowApp: 't',
  },
  en: {
    addDomain: 'd',
    addApp: 'a',
    presets: { 30: 'm', 60: '1', 120: '2', 180: '3' },
    modes: { normal: 'n', strict: 't', hardcore: 'h', exam: 'x' },
    save: 'v',
    block: 'b',
    saveName: 'v',
    cancelName: 'c',
    customize: 'u',
    newSchedule: 'w',
    newLimit: 'i',
    allowDomain: 'l',
    allowApp: 'o',
  },
});

/** Every fixed key, so list tiles never take one of them. */
export function fixedBloqueosKeys(): string[] {
  const k = BLOQUEOS_KEYS;
  return [
    k.addDomain,
    k.addApp,
    ...Object.values(k.presets),
    ...Object.values(k.modes),
    k.save,
    k.block,
    k.saveName,
    k.cancelName,
    k.customize,
    k.newSchedule,
    k.newLimit,
    k.allowDomain,
    k.allowApp,
  ];
}

/** Exam quick tiles (1 h | 2 h | 3 h, then «Personalizar…»). */
export const EXAM_PRESETS = [60, 120, 180] as const;

/** Main keeps template names this short (`TEMPLATE_LABEL_MAX` in main's prefs store). */
export const TEMPLATE_LABEL_MAX = 40;

export type SchedulesData =
  | { status: 'loading' }
  | { status: 'ready'; list: readonly Schedule[] }
  | { status: 'error'; error: UiError };

/** What the window fetched itself (docs/DESKTOP.md §5.1: not in the snapshot). */
export interface BloqueosData {
  schedules: SchedulesData;
  /** Switch values being saved (optimistic until the guardian answers). */
  pendingSchedules: Readonly<Record<string, boolean>>;
  /** Running process names for the apps suggestions (`[]` until they arrive). */
  processNames: readonly string[];
  /**
   * The user picked a duration since the window was opened with a seed that had none (a preset,
   * a typed value, a template). Until then that duration is «sin elegir».
   */
  durationPicked?: boolean;
  /** The guardian's settings (the whitelist extras), fetched with the schedules. */
  settings?: SettingsData;
  /** A schedule write (create, update, delete) is waiting for the guardian. */
  scheduleSaving?: boolean;
  /** A whitelist change (`settings:put`) is waiting for the guardian. */
  whitelistSaving?: boolean;
  /** `GET /v1/limits`, fetched with the schedules. */
  limits?: LimitsData;
  /** A limit write (create, update, delete, cancel a change) is waiting for the guardian. */
  limitSaving?: boolean;
  /** The limit whose row write is waiting («Cancelar cambio»). */
  limitRowSaving?: string | null;
}

/** Why «Bloquear…» is disabled: the draft's own problems, or a duration nobody chose yet. */
export type FormProblem = DraftProblem | 'no_duration';

export interface OptionView<T extends string> {
  value: T;
  label: string;
  help: string;
  tone: Accent;
  mnemonic: string;
}

export interface TargetsView {
  /** «Qué bloquear: Vídeo y streaming +2» (the count is in the «+N»; no datum). */
  title: string;
  /** Examen: the whitelist replaces the picker. */
  whitelist: { intro: string; list: string } | null;
  search: CatalogSearch | null;
  groups: CatalogGroup[];
  domains: EntryView[];
  apps: EntryView[];
  suggestions: AppSuggestion[];
}

export interface PresetView {
  minutes: number;
  label: string;
  help: string;
  selected: boolean;
  mnemonic: string | undefined;
}

export interface DurationView {
  /** «Duración: 1 h», or «Duración: sin elegir» while `open`. */
  title: string;
  /** «hasta 18:00», «hasta mañana 08:00»; `null` while `open`. */
  datum: string | null;
  /** Seeded from a phrase whose time was not understood, and nothing picked yet. */
  open: boolean;
  presets: PresetView[];
  /** Both fields are empty while `open` (their placeholders show). */
  fields: DurationFields;
}

export interface ModeView {
  title: string;
  datum: string;
  value: BlockMode;
  options: OptionView<BlockMode>[];
}

export interface ActiveRowView {
  id: string;
  label: string;
  until: string;
  tone: Accent;
}

export interface TemplateRowView {
  id: string;
  label: string;
  description: string;
  builtin: boolean;
  /** Alt + letter of «Usar» and of «Borrar» (user templates only). */
  useKey: string | undefined;
  removeKey: string | undefined;
}

export interface ScheduleEditorView {
  /** `null`: a new schedule. */
  id: string | null;
  /** «Nuevo horario: L–V 16:00–19:00 · Redes sociales», «Editar: …». */
  title: string;
  name: string;
  /** The name saved when «Nombre» stays empty («Redes sociales · L–V»). */
  namePlaceholder: string;
  reason: string;
  days: { day: IsoWeekday; short: string; long: string; checked: boolean }[];
  /** What the fields show (as typed, or the saved `HH:MM`). */
  start: string;
  end: string;
  /** «Dura 3 h», or what is wrong with a time (orange). */
  times: { text: string; tone: 'muted' | 'orange' };
  /** Examen: the whitelist line replaces the targets. */
  whitelist: string | null;
  categories: { id: CategoryId; name: string; checked: boolean }[];
  /** Services, apps, domains and processes beyond the categories (removable). */
  chips: ScheduleChip[];
  /** «Añadir lo del formulario de arriba» would add something. */
  fromForm: boolean;
  mode: BlockMode;
  /** Keys come after every list's (`undefined` once the window's 36 are taken). */
  modes: (Omit<OptionView<BlockMode>, 'mnemonic'> & { mnemonic: string | undefined })[];
  /** Hardcore and Examen: «Guardar» asks «¿Seguro?» with this line in red. */
  consequence: string | null;
  /** Why «Guardar» is disabled (the input, or a guard), `null` when it can send. */
  problem: string | null;
  /** The guardian's last refusal. */
  error: string | null;
  saving: boolean;
  /** «Borrar» (existing schedules): why it is disabled now, and its «¿Seguro?» line. */
  remove: { lock: string | null; consequence: string } | null;
  keys: { save: string | undefined; remove: string | undefined; cancel: string | undefined };
}

export interface SchedulesView {
  title: string;
  datum: string | null;
  status: SchedulesData['status'];
  error: UiError | null;
  rows: ScheduleRowView[];
  /** «Nuevo horario» shows while the list is loaded and no editor is open. */
  canCreate: boolean;
  editor: ScheduleEditorView | null;
}

export interface LimitEditorView {
  /** `null`: a new limit. */
  id: string | null;
  /** «Nuevo límite: Instagram · 45 min al día», «Editar: …». */
  title: string;
  name: string;
  namePlaceholder: string;
  minutesText: string;
  /** «45 min al día», or what is wrong with the minutes (orange). */
  minutes: { text: string; tone: 'muted' | 'orange' };
  days: { day: IsoWeekday; short: string; long: string; checked: boolean }[];
  categories: { id: CategoryId; name: string; checked: boolean }[];
  chips: ScheduleChip[];
  fromForm: boolean;
  mode: LimitMode;
  modes: (Omit<OptionView<LimitMode>, 'mnemonic'> & { mnemonic: string | undefined })[];
  reason: string;
  /** An edit that softens it: «Esto lo suaviza: se aplicará mañana 17:00…». */
  note: string | null;
  /** Hardcore: «Guardar» asks «¿Seguro?» with this line in red. */
  consequence: string | null;
  problem: string | null;
  error: string | null;
  saving: boolean;
  /** «Borrar» (existing limits): its «¿Seguro?» line. */
  remove: { consequence: string } | null;
  keys: { save: string | undefined; remove: string | undefined; cancel: string | undefined };
}

export interface LimitsView {
  title: string;
  /** «1 agotado hoy». */
  datum: string | null;
  /** `unsupported`: the guardian has no daily limits yet (an older version). */
  status: LimitsData['status'] | 'unsupported';
  error: UiError | null;
  rows: LimitRowView[];
  canCreate: boolean;
  editor: LimitEditorView | null;
}

export interface ExamWhitelistView extends WhitelistView {
  /** Running programs that match the app field. */
  suggestions: string[];
  saving: boolean;
}

export interface ExamView {
  title: string;
  datum: string;
  allowed: string;
  tiles: { minutes: number; label: string; help: string; mnemonic: string | undefined }[];
  whitelist: ExamWhitelistView;
}

export interface BloqueosView {
  seedLine: string | null;
  targets: TargetsView;
  duration: DurationView;
  mode: ModeView;
  /** Why «Bloquear…» is disabled (`null`: ready). */
  problem: FormProblem | null;
  problemText: string | null;
  active: { title: string; rows: ActiveRowView[]; emergency: boolean };
  templates: { title: string; rows: TemplateRowView[] };
  schedules: SchedulesView;
  limits: LimitsView;
  exam: ExamView;
}

/** Longest «Qué bloquear: …» label that fits its column (a long custom domain is cut with «…»). */
export const TARGETS_TITLE_MAX = 24;

/** `label` cut to `max` characters with «…», keeping a trailing « +N». */
export function fitLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const match = / \+\d+$/.exec(label);
  const tail = match ? match[0] : '';
  const head = label.slice(0, label.length - tail.length);
  const room = Math.max(1, max - tail.length - 1);
  return `${head.slice(0, room).trimEnd()}…${tail}`;
}

/** The study whitelist's site groups in the active language («Cuenta de Google», «Google Account»). */
function studyWhitelistNames(): string[] {
  const locale = activeLocale();
  return STUDY_WHITELIST.map((site) => studySiteName(site.id, locale));
}

function targetsView(form: BlockDraft, state: UiState, data: BloqueosData): TargetsView {
  const local = state.detail.bloqueos;
  const exam = form.mode === 'exam' || form.whitelistOnly;
  const count = selectedCount(form.targets);
  const entries = customEntries(form.targets);
  const names = studyWhitelistNames();
  const shown = names.slice(0, 6);
  return {
    title: exam
      ? E.targets.titleWhitelist
      : count === 0
        ? E.targets.titleNone
        : E.targets.title(fitLabel(targetsLabel(form.targets, false, 1), TARGETS_TITLE_MAX)),
    whitelist: exam
      ? {
          intro: E.targets.whitelistIntro,
          list: E.targets.whitelistList(shown.join(' · '), names.length - shown.length),
        }
      : null,
    search: exam ? null : searchCatalog(local.search, form.targets),
    groups: exam ? [] : catalogGroups(form.targets),
    domains: entries.domains,
    apps: entries.apps,
    suggestions: exam
      ? []
      : appSuggestions(
          local.processInput,
          data.processNames,
          form.targets,
          toCatalogPlatform(state.env.platform),
        ),
  };
}

/**
 * Whether the window was opened («No he entendido…» → Enter) from a phrase whose time the parser
 * did not understand: the form must not show a duration the user never chose.
 */
export function seedLeavesDurationOpen(state: UiState): boolean {
  const request = state.env.detail;
  return request?.name === 'bloqueos' && request.seed !== null && request.seed.end === null;
}

function durationView(form: BlockDraft, nowMs: number, open: boolean): DurationView {
  const fields = durationFields(form, nowMs);
  const preset = open ? null : selectedPreset(form);
  return {
    title: open ? E.duration.titleOpen : E.duration.title(fields.minutesText),
    datum: open ? null : E.duration.datum(whenLabel(fields.endsAtMs, nowMs)),
    open,
    presets: DURATION_PRESETS.map((minutes) => {
      const label = durationLabel(minutes);
      return {
        minutes,
        label,
        help: E.duration.presetHelp(label, untilPhrase(nowMs + minutes * 60_000, nowMs)),
        selected: preset === minutes,
        mnemonic: BLOQUEOS_KEYS.presets[minutes],
      };
    }),
    fields: open ? { ...fields, minutesText: '', untilText: '' } : fields,
  };
}

function modeView(form: BlockDraft): ModeView {
  return {
    title: E.mode.title(modeLabel(form.mode)),
    datum: E.mode.datum[form.mode],
    value: form.mode,
    options: BLOCK_MODES.map((mode) => ({
      value: mode,
      label: modeLabel(mode),
      help: E.mode.help[mode],
      tone: modeAccent(mode),
      mnemonic: BLOQUEOS_KEYS.modes[mode],
    })),
  };
}

function activeView(state: UiState, nowMs: number): BloqueosView['active'] {
  const blocks = state.snapshot.state?.blocks ?? [];
  return {
    title: E.active.title(blocks.length),
    rows: blocks.map((block) => {
      const targets = targetsLabel(block.targets, block.whitelistOnly, 2);
      const what = block.kind === 'punishment' ? `${E.active.punishment}: ${targets}` : targets;
      return {
        id: block.id,
        label: E.active.row(what, modeLabel(block.mode)),
        until: untilPhrase(Date.parse(block.endsAt), nowMs),
        tone: modeAccent(block.mode),
      };
    }),
    emergency:
      state.snapshot.state?.emergency != null || blocks.some((block) => block.emergencyEligible),
  };
}

/**
 * Keys of the tiles that repeat or come and go (exam presets, then «Usar» per template, «Borrar»
 * per user template, «Editar» per schedule, then the schedule editor's modes and actions): what
 * the fixed tiles left, in that order, so the lists above keep their letters when the editor
 * opens.
 */
function listKeys(
  state: UiState,
  schedules: readonly Schedule[],
  editorOpen: boolean,
  limits: readonly DailyLimit[] = [],
  limitEditorOpen = false,
): {
  exam: (string | undefined)[];
  use: (string | undefined)[];
  remove: Map<string, string | undefined>;
  edit: Map<string, string | undefined>;
  editorModes: (string | undefined)[];
  editorActions: {
    save: string | undefined;
    remove: string | undefined;
    cancel: string | undefined;
  };
  limitEdit: Map<string, string | undefined>;
  limitCancel: Map<string, string | undefined>;
  limitModes: (string | undefined)[];
  limitActions: {
    save: string | undefined;
    remove: string | undefined;
    cancel: string | undefined;
  };
} {
  const templates = state.snapshot.templates;
  const own = templates.filter((t) => !t.builtin);
  const examLabels = EXAM_PRESETS.map((m) => E.exam.tile(durationLabel(m)));
  const editorLabels = editorOpen
    ? [
        ...BLOCK_MODES.map((mode) => modeLabel(mode)),
        E.schedules.editor.save,
        E.schedules.editor.remove,
        E.schedules.editor.cancel,
      ]
    : [];
  const pendingLimits = limits.filter((l) => l.pendingChange !== null);
  const limitEditorLabels = limitEditorOpen
    ? [
        ...LIMIT_MODES.map((mode) => modeLabel(mode)),
        E.limits.editor.save,
        E.limits.editor.remove,
        E.limits.editor.cancel,
      ]
    : [];
  const keys = allocateMnemonics(
    [
      ...examLabels,
      ...templates.map(() => E.templates.use),
      ...own.map(() => E.templates.remove),
      ...schedules.map(() => E.schedules.edit),
      ...editorLabels,
      ...limits.map(() => E.limits.edit),
      ...pendingLimits.map(() => E.limits.cancelChange),
      ...limitEditorLabels,
    ],
    fixedBloqueosKeys(),
  );
  let at = 0;
  const take = (n: number): (string | undefined)[] => {
    const out = keys.slice(at, at + n);
    at += n;
    return out;
  };
  const exam = take(examLabels.length);
  const use = take(templates.length);
  const removeKeys = take(own.length);
  const editKeys = take(schedules.length);
  const modeKeys = take(editorOpen ? BLOCK_MODES.length : 0);
  const [save, remove, cancel] = take(editorOpen ? 3 : 0);
  const limitEditKeys = take(limits.length);
  const limitCancelKeys = take(pendingLimits.length);
  const limitModeKeys = take(limitEditorOpen ? LIMIT_MODES.length : 0);
  const [limitSave, limitRemove, limitClose] = take(limitEditorOpen ? 3 : 0);
  return {
    limitEdit: new Map(limits.map((l, i) => [l.id, limitEditKeys[i]])),
    limitCancel: new Map(pendingLimits.map((l, i) => [l.id, limitCancelKeys[i]])),
    limitModes: limitModeKeys,
    limitActions: { save: limitSave, remove: limitRemove, cancel: limitClose },
    exam,
    use,
    remove: new Map(own.map((t, i) => [t.id, removeKeys[i]])),
    edit: new Map(schedules.map((s, i) => [s.id, editKeys[i]])),
    editorModes: modeKeys,
    editorActions: { save, remove, cancel },
  };
}

function templatesView(
  state: UiState,
  keys: ReturnType<typeof listKeys>,
): BloqueosView['templates'] {
  const templates = state.snapshot.templates;
  return {
    title: E.templates.title(templates.length),
    rows: templates.map((t, i) => ({
      id: t.id,
      label: templateLabel(t),
      description: E.templates.desc(
        targetsLabel(t.targets, t.whitelistOnly || t.mode === 'exam', 2),
        durationLabel(t.durationMinutes),
        t.mode ? modeLabel(t.mode) : E.templates.defaultMode,
      ),
      builtin: t.builtin,
      useKey: keys.use[i],
      removeKey: t.builtin ? undefined : keys.remove.get(t.id),
    })),
  };
}

function editorView(
  state: UiState,
  data: BloqueosData,
  nowMs: number,
  keys: ReturnType<typeof listKeys>,
): ScheduleEditorView | null {
  const editor = state.detail.bloqueos.schedule;
  if (!editor) return null;
  const list = data.schedules.status === 'ready' ? data.schedules.list : [];
  const before = editor.id === null ? null : (list.find((s) => s.id === editor.id) ?? null);
  const input = editor.input;
  const whitelist = isWhitelistSchedule(input);
  const summary = scheduleSummary(input);
  const problem = scheduleProblem(input, before, nowMs, list.length);
  const ES = E.schedules.editor;
  const timeProblem =
    problem === 'bad_start' ||
    problem === 'bad_end' ||
    problem === 'same_time' ||
    problem === 'too_short'
      ? scheduleProblemText(problem, before, nowMs)
      : null;
  return {
    id: editor.id,
    title: editor.id === null ? ES.titleNew(summary) : ES.titleEdit(summary),
    name: input.name,
    namePlaceholder: scheduleAutoName(input),
    reason: input.reason,
    days: ISO_WEEKDAYS.map((day) => ({
      day,
      short: E.schedules.days[day - 1] ?? String(day),
      long: ES.dayNames[day - 1] ?? String(day),
      checked: input.days.includes(day),
    })),
    start: input.start,
    end: input.end,
    times: timeProblem
      ? { text: timeProblem, tone: 'orange' }
      : { text: scheduleWindowLabel(input) ?? ES.timesHelp, tone: 'muted' },
    whitelist: whitelist ? ES.whitelist : null,
    categories: scheduleCategories(input.targets),
    chips: whitelist ? [] : scheduleChips(input.targets),
    fromForm:
      !whitelist &&
      !isWhitelistSchedule(state.detail.bloqueos.form) &&
      formAddsTargets(input.targets, state.detail.bloqueos.form.targets),
    mode: input.mode,
    modes: BLOCK_MODES.map((mode, i) => ({
      value: mode,
      label: modeLabel(mode),
      help: E.mode.help[mode],
      tone: modeAccent(mode),
      mnemonic: keys.editorModes[i],
    })),
    consequence: scheduleNeedsConsequence(input)
      ? input.mode === 'exam'
        ? ES.consequence.exam
        : ES.consequence.hardcore
      : null,
    problem: problem ? scheduleProblemText(problem, before, nowMs) : null,
    error: editor.error ? scheduleErrorText(editor.error, nowMs) : null,
    saving: data.scheduleSaving === true,
    remove: before
      ? {
          lock: scheduleDeleteLock(before, nowMs),
          consequence: ES.removeConsequence(before.name || summary),
        }
      : null,
    keys: keys.editorActions,
  };
}

function schedulesView(
  state: UiState,
  data: BloqueosData,
  nowMs: number,
  keys: ReturnType<typeof listKeys>,
): SchedulesView {
  const next = state.snapshot.state?.nextSchedule ?? null;
  const datum = next ? E.schedules.next(whenLabel(Date.parse(next.startsAt), nowMs)) : null;
  const s = data.schedules;
  const editing = state.detail.bloqueos.schedule;
  const editor = editorView(state, data, nowMs, keys);
  if (s.status === 'loading') {
    return {
      title: E.schedules.loading,
      datum,
      status: s.status,
      error: null,
      rows: [],
      canCreate: false,
      editor,
    };
  }
  if (s.status === 'error') {
    return {
      title: E.schedules.unavailable,
      datum,
      status: s.status,
      error: s.error,
      rows: [],
      canCreate: false,
      editor,
    };
  }
  const rows = s.list.map((schedule) =>
    scheduleRow(schedule, nowMs, data.pendingSchedules[schedule.id], {
      editing: editing?.id === schedule.id,
      editKey: keys.edit.get(schedule.id),
    }),
  );
  const on = rows.filter((r) => r.enabled).length;
  return {
    title: E.schedules.title(on, rows.length),
    datum,
    status: s.status,
    error: null,
    rows,
    canCreate: editing === null,
    editor,
  };
}

function limitEditorView(
  state: UiState,
  data: BloqueosData,
  list: readonly DailyLimit[],
  nowMs: number,
  keys: ReturnType<typeof listKeys>,
): LimitEditorView | null {
  const editor = state.detail.bloqueos.limit;
  if (!editor) return null;
  const LE = E.limits.editor;
  const before = editor.id === null ? null : (list.find((l) => l.id === editor.id) ?? null);
  const input = editor.input;
  const minutes = editorMinutes(editor, nowMs);
  const problem = limitEditorProblem(editor, nowMs, list.length);
  const summary = limitSummary(input, minutes);
  const minutesProblem = problem === 'minutes_text' || problem === 'minutes';
  const request = { ...input, dailyMinutes: minutes ?? input.dailyMinutes };
  const weakens = before !== null && problem === null && limitEditWeakens(before, request);
  const form = state.detail.bloqueos.form;
  const formWhitelist = form.mode === 'exam' || form.whitelistOnly;
  const when = whenLabel(pendingEstimate(nowMs), nowMs);
  return {
    id: editor.id,
    title: editor.id === null ? LE.titleNew(summary) : LE.titleEdit(summary),
    name: input.name,
    namePlaceholder: limitAutoName(input.targets),
    minutesText: editor.minutesText,
    minutes: minutesProblem
      ? { text: limitEditorProblemText(problem), tone: 'orange' }
      : { text: LE.minutesHelp(LIMIT_TEXT.perDay(minutes ?? input.dailyMinutes)), tone: 'muted' },
    days: ISO_WEEKDAYS.map((day) => ({
      day,
      short: E.schedules.days[day - 1] ?? String(day),
      long: E.schedules.editor.dayNames[day - 1] ?? String(day),
      checked: input.days.includes(day),
    })),
    categories: scheduleCategories(input.targets),
    chips: scheduleChips(input.targets),
    fromForm: !formWhitelist && formAddsTargets(input.targets, form.targets),
    mode: input.mode,
    modes: LIMIT_MODES.map((mode, i) => ({
      value: mode,
      label: modeLabel(mode),
      help: E.mode.help[mode],
      tone: modeAccent(mode),
      mnemonic: keys.limitModes[i],
    })),
    reason: input.reason,
    note: weakens ? LE.weakens(when) : null,
    consequence: limitNeedsConsequence(input.mode) ? LE.consequence : null,
    problem: problem ? limitEditorProblemText(problem) : null,
    error: editor.error ? limitErrorText(editor.error) : null,
    saving: data.limitSaving === true,
    remove: before ? { consequence: LE.removeConsequence(before.name, when) } : null,
    keys: keys.limitActions,
  };
}

function limitsView(
  state: UiState,
  data: BloqueosData,
  nowMs: number,
  keys: ReturnType<typeof listKeys>,
  list: readonly DailyLimit[],
): LimitsView {
  const d = data.limits ?? { status: 'loading' as const };
  const editing = state.detail.bloqueos.limit;
  if (!limitsSupported(state.snapshot)) {
    return {
      title: LIMIT_TEXT.sectionTitle,
      datum: null,
      status: 'unsupported',
      error: null,
      rows: [],
      canCreate: false,
      editor: null,
    };
  }
  const editor = limitEditorView(state, data, list, nowMs, keys);
  if (d.status === 'loading' || d.status === 'error') {
    return {
      title: d.status === 'loading' ? E.limits.loading : E.limits.unavailable,
      datum: null,
      status: d.status,
      error: d.status === 'error' ? d.error : null,
      rows: [],
      canCreate: false,
      editor,
    };
  }
  const rows = list.map((limit) =>
    limitRow(limit, nowMs, {
      editing: editing?.id === limit.id,
      saving: data.limitRowSaving === limit.id,
      editKey: keys.limitEdit.get(limit.id),
      cancelKey: keys.limitCancel.get(limit.id),
    }),
  );
  const reached = list.filter((l) => limitReachedToday(l)).length;
  return {
    title: E.limits.title(list.length),
    datum: reached > 0 ? E.limits.datum(reached) : null,
    status: 'ready',
    error: null,
    rows,
    canCreate: editing === null,
    editor,
  };
}

function examView(
  state: UiState,
  data: BloqueosData,
  nowMs: number,
  keys: readonly (string | undefined)[],
): ExamView {
  const names = studyWhitelistNames();
  const shown = names.slice(0, 5);
  const settings = data.settings ?? { status: 'loading' as const };
  const whitelist = whitelistView(settings, nowMs);
  const lists =
    settings.status === 'ready' ? whitelistLists(settings.value) : { domains: [], processes: [] };
  return {
    title: E.exam.title,
    datum: E.exam.datum,
    allowed: E.targets.whitelistList(shown.join(' · '), names.length - shown.length),
    tiles: EXAM_PRESETS.map((minutes, i) => {
      const label = durationLabel(minutes);
      return {
        minutes,
        label: E.exam.tile(label),
        help: E.exam.tileHelp(label),
        mnemonic: keys[i],
      };
    }),
    whitelist: {
      ...whitelist,
      suggestions:
        settings.status === 'ready'
          ? whitelistSuggestions(
              state.detail.bloqueos.exam.processInput,
              data.processNames,
              lists,
              toCatalogPlatform(state.env.platform),
            )
          : [],
      saving: data.whitelistSaving === true,
    },
  };
}

/** The draft's own problem first when nothing is chosen to block, then an unchosen duration. */
export function formProblem(
  draft: BlockDraft,
  nowMs: number,
  durationOpen: boolean,
): FormProblem | null {
  const problem = draftProblem(draft, nowMs);
  if (problem === 'no_targets') return problem;
  if (durationOpen) return 'no_duration';
  return problem;
}

export function deriveBloqueosView(
  state: UiState,
  nowMs: number,
  data: BloqueosData,
): BloqueosView {
  const local = state.detail.bloqueos;
  const form = local.form;
  const open = seedLeavesDurationOpen(state) && data.durationPicked !== true;
  const problem = formProblem(form, nowMs, open);
  const scheduleList = data.schedules.status === 'ready' ? data.schedules.list : [];
  const limitList =
    data.limits?.status === 'ready'
      ? mergeLimits(data.limits.list, state.snapshot.state?.limits)
      : [];
  const keys = listKeys(
    state,
    scheduleList,
    local.schedule !== null,
    limitList,
    local.limit !== null,
  );
  return {
    seedLine: local.seedPhrase ? E.seed(local.seedPhrase) : null,
    targets: targetsView(form, state, data),
    duration: durationView(form, nowMs, open),
    mode: modeView(form),
    problem,
    problemText: problem ? E.actions.problem[problem] : null,
    active: activeView(state, nowMs),
    templates: templatesView(state, keys),
    schedules: schedulesView(state, data, nowMs, keys),
    limits: limitsView(state, data, nowMs, keys, limitList),
    exam: examView(state, data, nowMs, keys.exam),
  };
}

/** Name offered when saving the form as a template: «YouTube · 1 h». */
export function suggestedTemplateName(form: BlockDraft, nowMs: number): string {
  const what =
    form.mode === 'exam' || form.whitelistOnly
      ? modeLabel('exam')
      : targetsLabel(form.targets, false, 1);
  const label = `${what} · ${durationFields(form, nowMs).minutesText}`;
  return label.length <= TEMPLATE_LABEL_MAX ? label : label.slice(0, TEMPLATE_LABEL_MAX).trim();
}

/** Why a template name cannot be saved, or `null`. */
export function templateNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return E.actions.nameEmpty;
  if (trimmed.length > TEMPLATE_LABEL_MAX) return E.actions.nameLong(TEMPLATE_LABEL_MAX);
  return null;
}
