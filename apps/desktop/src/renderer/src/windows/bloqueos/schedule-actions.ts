/**
 * Actions of the schedule editor (`useBloqueosWindow` builds them): open, edit the fields in
 * `detail.bloqueos.schedule` (fixture-settable), save with `schedules:create` / `update`,
 * delete with `schedules:delete`. The guardian decides; a refusal stays on the editor's help
 * line (`schedule.error`) and a success closes the editor with «Guardado: …» under the list.
 *
 * A create sends one `Idempotency-Key` per intention: a retry of the same body reuses it (a
 * request that landed during a timeout replays instead of creating a twin), an edited body
 * gets a new one (the guardian would answer 409 `idempotency_conflict`).
 */
import type { CategoryId } from '@centrate/shared/catalog';
import type { BlockMode, IsoWeekday, Schedule, ScheduleId } from '@centrate/shared/domain';
import type { ScheduleInput } from '@centrate/shared/guardian-api';
import type { CentrateBridge } from '../../../../shared/ipc';
import type {
  BloqueosLocalState,
  ScheduleEditorState,
  UiError,
  UiState,
} from '../../../../shared/ui-state';
import { BLOQUEOS } from './i18n';
import {
  editorFor,
  mergeTargets,
  newScheduleInput,
  scheduleErrorText,
  systemTimezone,
  toScheduleRequest,
  upsertSchedule,
  withDay,
  withScheduleCategory,
  withScheduleMode,
  withoutSchedule,
  withoutScheduleTarget,
  type ScheduleChip,
} from './schedule-editor';
import { isWhitelistSchedule, parseClockText, scheduleSummary } from './schedules';
import type { SchedulesData } from './view';

const ES = BLOQUEOS.schedules.editor;

export interface ScheduleActions {
  newSchedule(): void;
  editSchedule(id: ScheduleId): void;
  closeSchedule(): void;
  setScheduleName(text: string): void;
  setScheduleReason(text: string): void;
  toggleScheduleDay(day: IsoWeekday, on: boolean): void;
  setScheduleStart(text: string): void;
  setScheduleEnd(text: string): void;
  /** Leaving a time field: «16» becomes «16:00». */
  commitScheduleTimes(): void;
  toggleScheduleCategory(id: CategoryId, on: boolean): void;
  removeScheduleTarget(chip: ScheduleChip): void;
  addFormTargets(): void;
  setScheduleMode(mode: BlockMode): void;
  /** «Guardar» (after the in-place «¿Seguro?» in Hardcore and Examen). */
  saveSchedule(): void;
  /** «Borrar» (after its «¿Seguro?»). */
  deleteSchedule(): void;
}

export interface ScheduleActionDeps {
  bridge: CentrateBridge;
  getState(): UiState;
  now(): number;
  updateLocal(fn: (local: BloqueosLocalState) => BloqueosLocalState): void;
  getSchedules(): SchedulesData;
  setSchedules(fn: (current: SchedulesData) => SchedulesData): void;
  setSaving(saving: boolean): void;
  isSaving(): boolean;
  /** The editor's current problem (`null`: «Guardar» may send). */
  problem(): string | null;
  /** A result under the list (announced too); `null` clears it. */
  notify(notice: { text: string; tone: 'muted' | 'red' | 'orange' | 'green' } | null): void;
  /** Screen readers only (the editor's help line already shows it). */
  announce(text: string): void;
  mounted(): boolean;
  /** Remembers the last create attempt (its body and key) across renders. */
  lastCreate: { current: { body: string; intentId: string } | null };
  newIntentId(): string;
}

export function createScheduleActions(d: ScheduleActionDeps): ScheduleActions {
  const editor = (): ScheduleEditorState | null => d.getState().detail.bloqueos.schedule;

  const setEditor = (fn: (e: ScheduleEditorState) => ScheduleEditorState | null): void =>
    d.updateLocal((local) => {
      if (!local.schedule) return local;
      const next = fn(local.schedule);
      return next === local.schedule ? local : { ...local, schedule: next };
    });

  const updateInput = (fn: (input: ScheduleInput) => ScheduleInput): void =>
    setEditor((e) => {
      const input = fn(e.input);
      return input === e.input && e.error === null ? e : { ...e, input, error: null };
    });

  const open = (next: ScheduleEditorState): void => {
    d.lastCreate.current = null;
    d.notify(null);
    d.updateLocal((local) => ({ ...local, schedule: next }));
  };

  const findSchedule = (id: string): Schedule | undefined => {
    const list = d.getSchedules();
    return list.status === 'ready' ? list.list.find((s) => s.id === id) : undefined;
  };

  const fail = (error: UiError, op: 'save' | 'delete'): void => {
    setEditor((e) => ({ ...e, error }));
    d.announce(scheduleErrorText(error, d.now(), op));
  };

  return {
    newSchedule: () => {
      const state = d.getState();
      const form = state.detail.bloqueos.form;
      const formTargets = isWhitelistSchedule(form) ? null : form.targets;
      open({
        id: null,
        input: newScheduleInput({
          timezone: systemTimezone(),
          mode: state.snapshot.prefs.defaultMode,
          targets: formTargets,
        }),
        error: null,
      });
    },
    editSchedule: (id) => {
      const schedule = findSchedule(id);
      if (schedule) open(editorFor(schedule));
    },
    closeSchedule: () => {
      d.lastCreate.current = null;
      d.updateLocal((local) => (local.schedule ? { ...local, schedule: null } : local));
    },
    setScheduleName: (text) =>
      updateInput((input) => (input.name === text ? input : { ...input, name: text })),
    setScheduleReason: (text) =>
      updateInput((input) => (input.reason === text ? input : { ...input, reason: text })),
    toggleScheduleDay: (day, on) => updateInput((input) => withDay(input, day, on)),
    setScheduleStart: (text) =>
      updateInput((input) => (input.start === text ? input : { ...input, start: text })),
    setScheduleEnd: (text) =>
      updateInput((input) => (input.end === text ? input : { ...input, end: text })),
    commitScheduleTimes: () =>
      updateInput((input) => {
        const start = parseClockText(input.start) ?? input.start;
        const end = parseClockText(input.end) ?? input.end;
        return start === input.start && end === input.end ? input : { ...input, start, end };
      }),
    toggleScheduleCategory: (id, on) => updateInput((input) => withScheduleCategory(input, id, on)),
    removeScheduleTarget: (chip) => updateInput((input) => withoutScheduleTarget(input, chip)),
    addFormTargets: () => {
      const form = d.getState().detail.bloqueos.form;
      if (isWhitelistSchedule(form)) return;
      updateInput((input) => ({ ...input, targets: mergeTargets(input.targets, form.targets) }));
    },
    setScheduleMode: (mode) =>
      updateInput((input) => (input.mode === mode ? input : withScheduleMode(input, mode))),

    saveSchedule: () => {
      const current = editor();
      if (!current || d.isSaving() || d.problem() !== null) return;
      const body = toScheduleRequest(current.input, true);
      const summary = scheduleSummary(body);
      d.setSaving(true);
      d.notify(null);
      const finish = (schedule: Schedule): void => {
        d.lastCreate.current = null;
        d.setSchedules((s) =>
          s.status === 'ready' ? { ...s, list: upsertSchedule(s.list, schedule) } : s,
        );
        d.updateLocal((local) => ({ ...local, schedule: null }));
        d.notify({ text: ES.saved(summary), tone: 'green' });
      };
      const request =
        current.id === null
          ? (() => {
              const key = JSON.stringify(body);
              const last = d.lastCreate.current;
              const intentId = last && last.body === key ? last.intentId : d.newIntentId();
              d.lastCreate.current = { body: key, intentId };
              return d.bridge.invoke('schedules:create', { intentId, input: body });
            })()
          : d.bridge.invoke('schedules:update', { id: current.id, input: body });
      void request.then(
        (result) => {
          if (!d.mounted()) return;
          d.setSaving(false);
          if (result.ok) finish(result.value);
          else fail(result.error, 'save');
        },
        () => {
          if (d.mounted()) d.setSaving(false);
        },
      );
    },

    deleteSchedule: () => {
      const current = editor();
      if (!current || current.id === null || d.isSaving()) return;
      const id = current.id;
      const before = findSchedule(id);
      const name = before?.name || scheduleSummary(current.input);
      d.setSaving(true);
      d.notify(null);
      void d.bridge.invoke('schedules:delete', { id }).then(
        (result) => {
          if (!d.mounted()) return;
          d.setSaving(false);
          if (!result.ok) {
            fail(result.error, 'delete');
            return;
          }
          d.setSchedules((s) =>
            s.status === 'ready' ? { ...s, list: withoutSchedule(s.list, id) } : s,
          );
          d.updateLocal((local) => ({ ...local, schedule: null }));
          d.notify({ text: ES.removed(name), tone: 'green' });
        },
        () => {
          if (d.mounted()) d.setSaving(false);
        },
      );
    },
  };
}
