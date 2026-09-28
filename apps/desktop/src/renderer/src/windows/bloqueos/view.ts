/**
 * View model of the Bloqueos window (PROMPT §4 «Formulario avanzado», §9, §10 «Ventanas de
 * detalle › Bloqueos»; docs/DESKTOP.md §7.7), pure. Sections, top to bottom:
 *
 * 1. the advanced form in two columns, one section per decision with the title as its state:
 *    «Qué bloquear: YouTube +1» on the left; «Duración: 1 h» · «hasta 18:00», «Modo: Estricto»
 *    and «Tu motivo» on the right; then «Guardar como plantilla | Bloquear…» (the draft goes to
 *    the main window's card, the one confirmation path);
 * 2. «Activos» (from the snapshot), «Plantillas», «Horarios» (fetched when the window opens,
 *    one switch per row) and «Modo examen» (whitelist + Hardcore).
 *
 * Nothing is invented (PROMPT §4): opened from a phrase whose time was not understood, the
 * duration stays «sin elegir» and «Bloquear…» says «Elige cuánto dura» until the user picks one.
 *
 * Every tile has an Alt + letter unique in the window (`BLOQUEOS_KEYS`, `allocateMnemonics`).
 * Components map this to the UI kit; everything a screenshot shows is derived here.
 */
import { STUDY_WHITELIST } from '@centrate/shared/catalog';
import type { Accent } from '@centrate/shared/design/tokens';
import { BLOCK_MODES, type BlockMode, type Schedule } from '@centrate/shared/domain';
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
import { localized } from '../../../../shared/i18n/locale';
import { BLOQUEOS } from './i18n';
import { allocateMnemonics } from './mnemonics';
import { scheduleRow, type ScheduleRowView } from './schedules';
import { untilPhrase, whenLabel } from './time';

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
  exam: 'blq-exam',
  search: 'blq-search',
  rows: {
    presets: 'blq-presets',
    modes: 'blq-modes',
    actions: 'blq-actions',
    naming: 'blq-naming',
    exam: 'blq-exam-row',
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

export interface SchedulesView {
  title: string;
  datum: string | null;
  status: SchedulesData['status'];
  error: UiError | null;
  rows: ScheduleRowView[];
}

export interface ExamView {
  title: string;
  datum: string;
  allowed: string;
  tiles: { minutes: number; label: string; help: string; mnemonic: string | undefined }[];
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

function targetsView(form: BlockDraft, state: UiState, data: BloqueosData): TargetsView {
  const local = state.detail.bloqueos;
  const exam = form.mode === 'exam' || form.whitelistOnly;
  const count = selectedCount(form.targets);
  const entries = customEntries(form.targets);
  const names = STUDY_WHITELIST.map((site) => site.name);
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
 * Keys of the tiles that repeat (exam presets, then «Usar» per template, then «Borrar» per user
 * template): what the fixed tiles left, in that order.
 */
function listKeys(state: UiState): {
  exam: (string | undefined)[];
  use: (string | undefined)[];
  remove: Map<string, string | undefined>;
} {
  const templates = state.snapshot.templates;
  const own = templates.filter((t) => !t.builtin);
  const examLabels = EXAM_PRESETS.map((m) => E.exam.tile(durationLabel(m)));
  const keys = allocateMnemonics(
    [...examLabels, ...templates.map(() => E.templates.use), ...own.map(() => E.templates.remove)],
    fixedBloqueosKeys(),
  );
  const exam = keys.slice(0, examLabels.length);
  const use = keys.slice(examLabels.length, examLabels.length + templates.length);
  const removeKeys = keys.slice(examLabels.length + templates.length);
  return { exam, use, remove: new Map(own.map((t, i) => [t.id, removeKeys[i]])) };
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

function schedulesView(state: UiState, data: BloqueosData, nowMs: number): SchedulesView {
  const next = state.snapshot.state?.nextSchedule ?? null;
  const datum = next ? E.schedules.next(whenLabel(Date.parse(next.startsAt), nowMs)) : null;
  const s = data.schedules;
  if (s.status === 'loading') {
    return { title: E.schedules.loading, datum, status: s.status, error: null, rows: [] };
  }
  if (s.status === 'error') {
    return { title: E.schedules.unavailable, datum, status: s.status, error: s.error, rows: [] };
  }
  const rows = s.list.map((schedule) =>
    scheduleRow(schedule, nowMs, data.pendingSchedules[schedule.id]),
  );
  const on = rows.filter((r) => r.enabled).length;
  return {
    title: E.schedules.title(on, rows.length),
    datum,
    status: s.status,
    error: null,
    rows,
  };
}

function examView(keys: readonly (string | undefined)[]): ExamView {
  const names = STUDY_WHITELIST.map((site) => site.name);
  const shown = names.slice(0, 5);
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
  const keys = listKeys(state);
  return {
    seedLine: local.seedPhrase ? E.seed(local.seedPhrase) : null,
    targets: targetsView(form, state, data),
    duration: durationView(form, nowMs, open),
    mode: modeView(form),
    problem,
    problemText: problem ? E.actions.problem[problem] : null,
    active: activeView(state, nowMs),
    templates: templatesView(state, keys),
    schedules: schedulesView(state, data, nowMs),
    exam: examView(keys.exam),
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
