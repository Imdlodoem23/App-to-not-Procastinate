/**
 * Actions of «Límites diarios» (`useBloqueosWindow` builds them): open the editor, edit its
 * fields in `detail.bloqueos.limit` (fixture-settable), save with `limits:create` / `update`,
 * «Borrar» with `limits:delete` (a pending deletion), and a row's «Cancelar cambio», which
 * re-sends the limit's effective definition (`limitInputFromLimit`: the guardian drops the
 * pending change). A refusal stays on the editor's help line; a success closes the editor with
 * «Guardado: …» under the list.
 *
 * A create sends one `Idempotency-Key` per intention: a retry of the same body reuses it, an
 * edited body gets a new one.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import type { DailyLimit, IsoWeekday, LimitId, LimitMode } from '@centrate/shared/domain';
import { limitInputFromLimit, type DailyLimitInput } from '@centrate/shared/guardian-api';
import { limitEditorFor, newLimitEditor, upsertLimit } from '../../../../shared/limits';
import type { CentrateBridge } from '../../../../shared/ipc';
import type {
  BloqueosLocalState,
  LimitEditorState,
  UiError,
  UiState,
} from '../../../../shared/ui-state';
import { BLOQUEOS } from './i18n';
import {
  limitEditWeakens,
  limitErrorText,
  limitSummary,
  pendingEstimate,
  toLimitRequest,
  withLimitDay,
  withoutLimitTarget,
  type LimitsData,
} from './limits';
import { withCategory } from './catalog';
import { mergeTargets, type ScheduleChip } from './schedule-editor';
import { whenLabel } from './time';

const LE = BLOQUEOS.limits.editor;

export interface LimitActions {
  newLimit(): void;
  editLimit(id: LimitId): void;
  closeLimit(): void;
  setLimitName(text: string): void;
  setLimitMinutes(text: string): void;
  setLimitReason(text: string): void;
  toggleLimitDay(day: IsoWeekday, on: boolean): void;
  toggleLimitCategory(id: CategoryId, on: boolean): void;
  removeLimitTarget(chip: ScheduleChip): void;
  addFormTargetsToLimit(): void;
  setLimitMode(mode: LimitMode): void;
  /** «Guardar» (after the in-place «¿Seguro?» in Hardcore). */
  saveLimit(): void;
  /** «Borrar» (after its «¿Seguro?»): a deletion that waits 24 h. */
  deleteLimit(): void;
  /** A row's «Cancelar cambio». */
  cancelLimitChange(id: LimitId): void;
  retryLimits(): void;
}

export interface LimitActionDeps {
  bridge: CentrateBridge;
  getState(): UiState;
  now(): number;
  updateLocal(fn: (local: BloqueosLocalState) => BloqueosLocalState): void;
  getLimits(): LimitsData;
  setLimits(fn: (current: LimitsData) => LimitsData): void;
  loadLimits(): void;
  setSaving(saving: boolean): void;
  isSaving(): boolean;
  setRowSaving(id: string | null): void;
  /** The editor's current problem (`null`: «Guardar» may send). */
  problem(): string | null;
  notify(notice: { text: string; tone: 'muted' | 'red' | 'orange' | 'green' } | null): void;
  announce(text: string): void;
  mounted(): boolean;
  lastCreate: { current: { body: string; intentId: string } | null };
  newIntentId(): string;
}

export function createLimitActions(d: LimitActionDeps): LimitActions {
  const editor = (): LimitEditorState | null => d.getState().detail.bloqueos.limit;

  const setEditor = (fn: (e: LimitEditorState) => LimitEditorState | null): void =>
    d.updateLocal((local) => {
      if (!local.limit) return local;
      const next = fn(local.limit);
      return next === local.limit ? local : { ...local, limit: next };
    });

  const updateInput = (fn: (input: DailyLimitInput) => DailyLimitInput): void =>
    setEditor((e) => {
      const input = fn(e.input);
      return input === e.input && e.error === null ? e : { ...e, input, error: null };
    });

  const open = (next: LimitEditorState): void => {
    d.lastCreate.current = null;
    d.notify(null);
    d.updateLocal((local) => ({ ...local, limit: next }));
  };

  const findLimit = (id: string): DailyLimit | undefined => {
    const list = d.getLimits();
    const own = list.status === 'ready' ? list.list.find((l) => l.id === id) : undefined;
    return own ?? d.getState().snapshot.state?.limits?.find((l) => l.id === id);
  };

  const fail = (error: UiError): void => {
    setEditor((e) => ({ ...e, error }));
    d.announce(limitErrorText(error));
  };

  const saved = (limit: DailyLimit): void =>
    d.setLimits((s) => (s.status === 'ready' ? { ...s, list: upsertLimit(s.list, limit) } : s));

  return {
    newLimit: () => {
      const form = d.getState().detail.bloqueos.form;
      const whitelist = form.mode === 'exam' || form.whitelistOnly;
      open(newLimitEditor({ targets: whitelist ? null : form.targets }));
    },
    editLimit: (id) => {
      const limit = findLimit(id);
      if (limit) open(limitEditorFor(limit));
    },
    closeLimit: () => {
      d.lastCreate.current = null;
      d.updateLocal((local) => (local.limit ? { ...local, limit: null } : local));
    },
    setLimitName: (text) =>
      updateInput((input) => (input.name === text ? input : { ...input, name: text })),
    setLimitMinutes: (text) =>
      setEditor((e) => (e.minutesText === text ? e : { ...e, minutesText: text, error: null })),
    setLimitReason: (text) =>
      updateInput((input) => (input.reason === text ? input : { ...input, reason: text })),
    toggleLimitDay: (day, on) => updateInput((input) => withLimitDay(input, day, on)),
    toggleLimitCategory: (id, on) =>
      updateInput((input) => {
        const targets = withCategory(input.targets, id, on);
        return targets === input.targets ? input : { ...input, targets };
      }),
    removeLimitTarget: (chip) => updateInput((input) => withoutLimitTarget(input, chip)),
    addFormTargetsToLimit: () => {
      const form = d.getState().detail.bloqueos.form;
      if (form.mode === 'exam' || form.whitelistOnly) return;
      updateInput((input) => ({ ...input, targets: mergeTargets(input.targets, form.targets) }));
    },
    setLimitMode: (mode) =>
      updateInput((input) => (input.mode === mode ? input : { ...input, mode })),

    saveLimit: () => {
      const current = editor();
      if (!current || d.isSaving() || d.problem() !== null) return;
      const now = d.now();
      const body = toLimitRequest(current, now, true);
      const summary = limitSummary(body, body.dailyMinutes);
      const before = current.id === null ? undefined : findLimit(current.id);
      const weakens = before !== undefined && limitEditWeakens(before, body);
      d.setSaving(true);
      d.notify(null);
      const request =
        current.id === null
          ? (() => {
              const key = JSON.stringify(body);
              const last = d.lastCreate.current;
              const intentId = last && last.body === key ? last.intentId : d.newIntentId();
              d.lastCreate.current = { body: key, intentId };
              return d.bridge.invoke('limits:create', { intentId, input: body });
            })()
          : d.bridge.invoke('limits:update', { id: current.id, input: body });
      void request.then(
        (result) => {
          if (!d.mounted()) return;
          d.setSaving(false);
          if (!result.ok) {
            fail(result.error);
            return;
          }
          d.lastCreate.current = null;
          saved(result.value);
          d.updateLocal((local) => ({ ...local, limit: null }));
          const pending = result.value.pendingChange;
          d.notify({
            text:
              weakens && pending
                ? LE.savedPending(summary, whenLabel(Date.parse(pending.effectiveAt), d.now()))
                : LE.saved(summary),
            tone: 'green',
          });
        },
        () => {
          if (d.mounted()) d.setSaving(false);
        },
      );
    },

    deleteLimit: () => {
      const current = editor();
      if (!current || current.id === null || d.isSaving()) return;
      const id = current.id;
      const name = findLimit(id)?.name ?? limitSummary(current.input, null);
      d.setSaving(true);
      d.notify(null);
      void d.bridge.invoke('limits:delete', { id }).then(
        (result) => {
          if (!d.mounted()) return;
          d.setSaving(false);
          if (!result.ok) {
            fail(result.error);
            return;
          }
          saved(result.value);
          d.updateLocal((local) => ({ ...local, limit: null }));
          const at = result.value.pendingChange?.effectiveAt;
          const when = whenLabel(at ? Date.parse(at) : pendingEstimate(d.now()), d.now());
          d.notify({ text: LE.removed(name, when), tone: 'green' });
        },
        () => {
          if (d.mounted()) d.setSaving(false);
        },
      );
    },

    cancelLimitChange: (id) => {
      const limit = findLimit(id);
      if (!limit || !limit.pendingChange) return;
      d.setRowSaving(id);
      d.notify(null);
      void d.bridge.invoke('limits:update', { id, input: limitInputFromLimit(limit) }).then(
        (result) => {
          if (!d.mounted()) return;
          d.setRowSaving(null);
          if (!result.ok) {
            d.notify({ text: limitErrorText(result.error), tone: 'red' });
            return;
          }
          saved(result.value);
          d.notify({ text: BLOQUEOS.limits.cancelled(limit.name), tone: 'green' });
        },
        () => {
          if (d.mounted()) d.setRowSaving(null);
        },
      );
    },

    retryLimits: () => {
      d.setLimits(() => ({ status: 'loading' }));
      d.loadLimits();
    },
  };
}
