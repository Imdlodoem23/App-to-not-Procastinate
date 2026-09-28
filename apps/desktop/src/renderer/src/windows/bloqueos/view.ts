/**
 * View model of the Bloqueos window (PROMPT §4 «Formulario avanzado», §9, §10 «Ventanas de
 * detalle › Bloqueos»; docs/DESKTOP.md §7.7), pure. Sections, top to bottom:
 *
 * 1. the advanced form, one section per decision with the title as its state: «Qué bloquear:
 *    YouTube, Instagram», «Duración: 1 h» · «hasta las 18:00», «Modo: Estricto», «Tu motivo»,
 *    then «Guardar como plantilla | Bloquear…» (the draft goes to the main window's card, the
 *    one confirmation path);
 * 2. «Activos» (from the snapshot), «Plantillas», «Horarios» (fetched when the window opens,
 *    one switch per row) and «Modo examen» (whitelist + Hardcore).
 *
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
import { BLOQUEOS_ES } from './i18n/es';
import { scheduleRow, type ScheduleRowView } from './schedules';
import { untilPhrase, whenLabel } from './time';

const E = BLOQUEOS_ES;

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
}

export interface OptionView<T extends string> {
  value: T;
  label: string;
  help: string;
  tone: Accent;
}

export interface TargetsView {
  title: string;
  datum: string | null;
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
}

export interface DurationView {
  title: string;
  datum: string;
  presets: PresetView[];
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
  tiles: { minutes: number; label: string; help: string }[];
}

export interface BloqueosView {
  seedLine: string | null;
  targets: TargetsView;
  duration: DurationView;
  mode: ModeView;
  /** Why «Bloquear…» is disabled (`null`: ready). */
  problem: DraftProblem | null;
  problemText: string | null;
  active: { title: string; rows: ActiveRowView[]; emergency: boolean };
  templates: { title: string; rows: TemplateRowView[] };
  schedules: SchedulesView;
  exam: ExamView;
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
        : E.targets.title(targetsLabel(form.targets, false, 2)),
    datum: exam || count === 0 ? null : E.targets.count(count),
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

function durationView(form: BlockDraft, nowMs: number): DurationView {
  const fields = durationFields(form, nowMs);
  const preset = selectedPreset(form);
  return {
    title: E.duration.title(fields.minutesText),
    datum: untilPhrase(fields.endsAtMs, nowMs),
    presets: DURATION_PRESETS.map((minutes) => {
      const label = durationLabel(minutes);
      return {
        minutes,
        label,
        help: E.duration.presetHelp(label, untilPhrase(nowMs + minutes * 60_000, nowMs)),
        selected: preset === minutes,
      };
    }),
    fields,
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

function templatesView(state: UiState): BloqueosView['templates'] {
  const templates = state.snapshot.templates;
  return {
    title: E.templates.title(templates.length),
    rows: templates.map((t) => ({
      id: t.id,
      label: t.label,
      description: E.templates.desc(
        targetsLabel(t.targets, t.whitelistOnly || t.mode === 'exam', 2),
        durationLabel(t.durationMinutes),
        t.mode ? modeLabel(t.mode) : E.templates.defaultMode,
      ),
      builtin: t.builtin,
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

function examView(): ExamView {
  const names = STUDY_WHITELIST.map((site) => site.name);
  const shown = names.slice(0, 5);
  return {
    title: E.exam.title,
    datum: E.exam.datum,
    allowed: E.targets.whitelistList(shown.join(' · '), names.length - shown.length),
    tiles: EXAM_PRESETS.map((minutes) => {
      const label = durationLabel(minutes);
      return { minutes, label: E.exam.tile(label), help: E.exam.tileHelp(label) };
    }),
  };
}

export function deriveBloqueosView(
  state: UiState,
  nowMs: number,
  data: BloqueosData,
): BloqueosView {
  const local = state.detail.bloqueos;
  const form = local.form;
  const problem = draftProblem(form, nowMs);
  return {
    seedLine: local.seedPhrase ? E.seed(local.seedPhrase) : null,
    targets: targetsView(form, state, data),
    duration: durationView(form, nowMs),
    mode: modeView(form),
    problem,
    problemText: problem ? E.actions.problem[problem] : null,
    active: activeView(state, nowMs),
    templates: templatesView(state),
    schedules: schedulesView(state, data, nowMs),
    exam: examView(),
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
