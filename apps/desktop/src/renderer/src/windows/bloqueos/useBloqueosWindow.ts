/**
 * State and actions of the Bloqueos window. The form lives in the detail window's local state
 * (`detail.bloqueos`, fixture-settable); schedules and running process names are fetched when
 * the window is shown (docs/DESKTOP.md §5.1) and kept in component state. Every action applies
 * at once; «Bloquear…» hands the draft to the main window's confirmation card
 * (`window:confirm-draft`), never to the guardian directly.
 *
 * Phase 5 adds the schedule editor (`schedule-actions.ts`) and the exam whitelist
 * (`whitelist-actions.ts`), whose extras come from the guardian's settings: fetched with the
 * schedules when the window is shown.
 *
 * Screen readers: results appear in help lines that are not live regions (some mount with the
 * result already in them); `announcement` carries each one to the window's single polite
 * region, which is there from the start. The catalog search reports its result count once the
 * typing stops.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryId } from '@centrate/shared/catalog';
import type { BlockMode, ScheduleId } from '@centrate/shared/domain';
import { emptyTargets } from '@centrate/shared/guardian-api';
import type { TargetSpec } from '@centrate/shared/domain';
import { errorCopy } from '../../i18n/errors';
import { useAnnouncer, type Announcement } from './announcer';
import { useNow } from '../../hooks/useNow';
import { useAppStore, useAppStoreApi } from '../../store/context';
import {
  draftFromTemplate,
  withMode,
  type BlockDraft,
  type BloqueosLocalState,
  type DetailRequest,
  type DraftEnd,
} from '../../../../shared/ui-state';
import {
  addCustomDomain,
  addProcessEntry,
  addSuggestion,
  searchCatalog,
  toCatalogPlatform,
  withCategory,
  withService,
  withoutEntry,
  type AppSuggestion,
  type EntryResult,
  type EntryView,
} from './catalog';
import { parseDurationText, parseUntilText } from './duration';
import { BLOQUEOS } from './i18n';
import { createLimitActions, type LimitActions } from './limit-actions';
import type { LimitsData } from './limits';
import { createScheduleActions, type ScheduleActions } from './schedule-actions';
import { createWhitelistActions, type WhitelistActions } from './whitelist-actions';
import type { SettingsData } from './whitelist';
import {
  deriveBloqueosView,
  suggestedTemplateName,
  templateNameProblem,
  type BloqueosData,
  type BloqueosView,
  type SchedulesData,
} from './view';

const E = BLOQUEOS;

export interface Notice {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
}

export type NoticeArea =
  'domains' | 'apps' | 'duration' | 'actions' | 'templates' | 'lists' | 'limits' | 'whitelist';

export interface BloqueosActions extends ScheduleActions, LimitActions, WhitelistActions {
  setSearch(text: string): void;
  /** Enter in the search box: mark the first result and clear the box. */
  pickFirstResult(): void;
  toggleCategory(id: CategoryId, on: boolean): void;
  toggleService(id: string, on: boolean): void;
  setDomainInput(text: string): void;
  addDomain(): void;
  setProcessInput(text: string): void;
  addProcess(): void;
  addSuggestion(suggestion: AppSuggestion): void;
  removeEntry(entry: EntryView): void;
  setPreset(minutes: number): void;
  commitMinutes(text: string): string | null;
  commitUntil(text: string): string | null;
  setMode(mode: BlockMode): void;
  setReason(text: string): void;
  startTemplate(): void;
  setTemplateName(text: string): void;
  saveTemplate(): void;
  cancelTemplate(): void;
  block(): void;
  applyTemplate(id: string): void;
  deleteTemplate(id: string): void;
  toggleSchedule(id: ScheduleId, enabled: boolean): void;
  retrySchedules(): void;
  startExam(minutes: number): void;
  customizeExam(): void;
  openEmergency(): void;
}

/** Quiet time after the last keystroke before the search result count is announced. */
export const SEARCH_ANNOUNCE_DELAY_MS = 600;

export interface BloqueosWindowApi {
  view: BloqueosView;
  local: BloqueosLocalState;
  nowMs: number;
  notices: Partial<Record<NoticeArea, Notice>>;
  announcement: Announcement | null;
  /** Says `text` through the window's polite region. */
  announce(text: string): void;
  actions: BloqueosActions;
}

/** Scroll a section of this window into view (the detail window scrolls; main never does). */
export function scrollToSection(id: string): void {
  document
    .querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'start' });
}

export function useBloqueosWindow(): BloqueosWindowApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const env = useAppStore((s) => s.env);
  const detail = useAppStore((s) => s.detail);
  const nowMs = useNow(60_000);

  const [schedules, setSchedules] = useState<SchedulesData>({ status: 'loading' });
  const [pendingSchedules, setPendingSchedules] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<SettingsData>({ status: 'loading' });
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [whitelistSaving, setWhitelistSaving] = useState(false);
  const [limits, setLimits] = useState<LimitsData>({ status: 'loading' });
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitRowSaving, setLimitRowSaving] = useState<string | null>(null);
  /** Latest values for the action factories (they run outside render). */
  const live = useRef({
    schedules,
    settings,
    scheduleSaving,
    whitelistSaving,
    limits,
    limitSaving,
  });
  live.current = { schedules, settings, scheduleSaving, whitelistSaving, limits, limitSaving };
  const lastCreate = useRef<{ body: string; intentId: string } | null>(null);
  const lastLimitCreate = useRef<{ body: string; intentId: string } | null>(null);
  const [processNames, setProcessNames] = useState<readonly string[]>([]);
  const [notices, setNotices] = useState<Partial<Record<NoticeArea, Notice>>>({});
  const { announcement, announce } = useAnnouncer();
  /** The request (door) during which the user picked a duration (`BloqueosData`). */
  const [pickedFor, setPickedFor] = useState<DetailRequest | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const notify = useCallback(
    (area: NoticeArea, notice: Notice | null) => {
      if (notice) announce(notice.text);
      setNotices((current) => {
        if (!notice && !current[area]) return current;
        const next = { ...current };
        if (notice) next[area] = notice;
        else delete next[area];
        return next;
      });
    },
    [announce],
  );

  const loadSchedules = useCallback(() => {
    void bridge.invoke('schedules:list', null).then(
      (result) => {
        if (!mounted.current) return;
        setSchedules(
          result.ok
            ? { status: 'ready', list: result.value }
            : { status: 'error', error: result.error },
        );
      },
      () => undefined,
    );
  }, [bridge]);

  const loadLimits = useCallback(() => {
    void bridge.invoke('limits:list', null).then(
      (result) => {
        if (!mounted.current) return;
        setLimits(
          result.ok
            ? { status: 'ready', list: result.value }
            : { status: 'error', error: result.error },
        );
      },
      () => undefined,
    );
  }, [bridge]);

  const loadSettings = useCallback(() => {
    void bridge.invoke('settings:get', null).then(
      (result) => {
        if (!mounted.current) return;
        setSettings(
          result.ok
            ? { status: 'ready', value: result.value }
            : { status: 'error', error: result.error },
        );
      },
      () => undefined,
    );
  }, [bridge]);

  const loadProcesses = useCallback(() => {
    void bridge.invoke('system:process-names', null).then(
      (result) => {
        if (mounted.current && result.ok) setProcessNames(result.value);
      },
      () => undefined,
    );
  }, [bridge]);

  // Fetch when the window is (re)opened: shown again, or retargeted by a door.
  useEffect(() => {
    if (!env.visible) return;
    loadSchedules();
    loadLimits();
    loadSettings();
    loadProcesses();
  }, [env.visible, env.detail, loadSchedules, loadLimits, loadSettings, loadProcesses]);

  const updateLocal = useCallback(
    (fn: (local: BloqueosLocalState) => BloqueosLocalState) => {
      api.getState().updateDetail((d) => {
        const next = fn(d.bloqueos);
        return next === d.bloqueos ? d : { ...d, bloqueos: next };
      });
    },
    [api],
  );

  const updateForm = useCallback(
    (fn: (form: BlockDraft) => BlockDraft) => {
      updateLocal((local) => {
        const form = fn(local.form);
        return form === local.form ? local : { ...local, form };
      });
      notify('actions', null);
    },
    [updateLocal, notify],
  );

  const updateTargets = useCallback(
    (fn: (targets: TargetSpec) => TargetSpec) => {
      updateForm((form) => {
        const targets = fn(form.targets);
        return targets === form.targets ? form : { ...form, targets };
      });
    },
    [updateForm],
  );

  const durationPicked = pickedFor !== null && pickedFor === env.detail;
  const view = useMemo(
    () =>
      deriveBloqueosView({ env, snapshot, main: api.getState().main, detail }, nowMs, {
        schedules,
        pendingSchedules,
        processNames,
        durationPicked,
        settings,
        scheduleSaving,
        whitelistSaving,
        limits,
        limitSaving,
        limitRowSaving,
      } satisfies BloqueosData),
    [
      api,
      env,
      snapshot,
      detail,
      nowMs,
      schedules,
      pendingSchedules,
      processNames,
      durationPicked,
      settings,
      scheduleSaving,
      whitelistSaving,
      limits,
      limitSaving,
      limitRowSaving,
    ],
  );

  // The search result count, once the typing stops (never on every keystroke).
  const search = view.targets.search;
  const resultCount = search ? search.categories.length + search.services.length : null;
  useEffect(() => {
    if (resultCount === null || !env.visible) return undefined;
    const timer = setTimeout(
      () => announce(E.targets.results(resultCount)),
      SEARCH_ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [detail.bloqueos.search, resultCount, env.visible, announce]);

  const actions = useMemo<BloqueosActions>(() => {
    const local = (): BloqueosLocalState => api.getState().detail.bloqueos;
    const platform = toCatalogPlatform(api.getState().env.platform);
    const now = (): number => api.getState().snapshot.harness?.frozenNowMs ?? Date.now();

    const applyEntry = (area: 'domains' | 'apps', result: EntryResult, clear: () => void): void => {
      if (!result.ok) {
        notify(area, { text: result.error, tone: 'orange' });
        return;
      }
      updateTargets(() => result.targets);
      clear();
      notify(area, result.note ? { text: result.note, tone: 'muted' } : null);
    };

    const setEnd = (end: DraftEnd): void => {
      updateForm((form) => ({ ...form, end }));
      setPickedFor(api.getState().env.detail);
    };

    const confirmDraft = (draft: BlockDraft): void => {
      bridge.send('window:confirm-draft', { draft });
      notify('actions', { text: E.actions.sent, tone: 'muted' });
    };

    const scheduleActions = createScheduleActions({
      bridge,
      getState: () => api.getState(),
      now,
      updateLocal,
      getSchedules: () => live.current.schedules,
      setSchedules,
      setSaving: setScheduleSaving,
      isSaving: () => live.current.scheduleSaving,
      problem: () => view.schedules.editor?.problem ?? null,
      notify: (notice) => notify('lists', notice),
      announce,
      mounted: () => mounted.current,
      lastCreate,
      newIntentId: () => crypto.randomUUID(),
    });

    const limitActions = createLimitActions({
      bridge,
      getState: () => api.getState(),
      now,
      updateLocal,
      getLimits: () => live.current.limits,
      setLimits,
      loadLimits,
      setSaving: setLimitSaving,
      isSaving: () => live.current.limitSaving,
      setRowSaving: setLimitRowSaving,
      problem: () => view.limits.editor?.problem ?? null,
      notify: (notice) => notify('limits', notice),
      announce,
      mounted: () => mounted.current,
      lastCreate: lastLimitCreate,
      newIntentId: () => crypto.randomUUID(),
    });

    const whitelistActions = createWhitelistActions({
      bridge,
      local,
      updateLocal,
      getSettings: () => live.current.settings,
      setSettings,
      loadSettings,
      platform: () => platform,
      now,
      isSaving: () => live.current.whitelistSaving,
      setSaving: setWhitelistSaving,
      notify: (notice) => notify('whitelist', notice),
      mounted: () => mounted.current,
    });

    return {
      ...scheduleActions,
      ...limitActions,
      ...whitelistActions,
      setSearch: (text) => updateLocal((l) => (l.search === text ? l : { ...l, search: text })),
      pickFirstResult: () => {
        const search = searchCatalog(local().search, local().form.targets);
        if (!search) return;
        const service = search.services.find((o) => !o.checked);
        const category = search.categories.find((c) => !c.checked);
        if (service) updateTargets((t) => withService(t, service.id, true));
        else if (category?.categoryId) {
          const id = category.categoryId;
          updateTargets((t) => withCategory(t, id, true));
        } else return;
        updateLocal((l) => ({ ...l, search: '' }));
      },
      toggleCategory: (id, on) => updateTargets((t) => withCategory(t, id, on)),
      toggleService: (id, on) => updateTargets((t) => withService(t, id, on)),
      setDomainInput: (text) => {
        updateLocal((l) => (l.domainInput === text ? l : { ...l, domainInput: text }));
        notify('domains', null);
      },
      addDomain: () =>
        applyEntry('domains', addCustomDomain(local().form.targets, local().domainInput), () =>
          updateLocal((l) => ({ ...l, domainInput: '' })),
        ),
      setProcessInput: (text) => {
        updateLocal((l) => (l.processInput === text ? l : { ...l, processInput: text }));
        notify('apps', null);
      },
      addProcess: () =>
        applyEntry(
          'apps',
          addProcessEntry(local().form.targets, local().processInput, platform),
          () => updateLocal((l) => ({ ...l, processInput: '' })),
        ),
      addSuggestion: (suggestion) =>
        applyEntry('apps', addSuggestion(local().form.targets, suggestion, platform), () =>
          updateLocal((l) => ({ ...l, processInput: '' })),
        ),
      removeEntry: (entry) => updateTargets((t) => withoutEntry(t, entry)),
      setPreset: (minutes) => {
        setEnd({ kind: 'duration', minutes });
        notify('duration', null);
      },
      commitMinutes: (text) => {
        const result = parseDurationText(text, now());
        if (!result.ok) return result.error;
        setEnd(result.end);
        return null;
      },
      commitUntil: (text) => {
        const result = parseUntilText(text, now());
        if (!result.ok) return result.error;
        setEnd(result.end);
        return null;
      },
      setMode: (mode) => updateForm((form) => withMode(form, mode)),
      setReason: (text) =>
        updateForm((form) => (form.reason === text ? form : { ...form, reason: text })),
      startTemplate: () =>
        updateLocal((l) => ({ ...l, templateName: suggestedTemplateName(l.form, now()) })),
      setTemplateName: (text) => updateLocal((l) => ({ ...l, templateName: text })),
      cancelTemplate: () => {
        updateLocal((l) => ({ ...l, templateName: null }));
        notify('actions', null);
      },
      saveTemplate: () => {
        if (view.problem) return;
        const l = local();
        const name = l.templateName ?? '';
        const problem = templateNameProblem(name);
        if (problem) {
          notify('actions', { text: problem, tone: 'orange' });
          return;
        }
        const form = l.form;
        const whitelistOnly = form.mode === 'exam' || form.whitelistOnly;
        const minutes = view.duration.fields.minutes;
        void bridge
          .invoke('templates:save', {
            id: null,
            label: name.trim(),
            targets: whitelistOnly ? emptyTargets() : form.targets,
            whitelistOnly,
            mode: form.mode,
            durationMinutes: minutes,
            reason: form.reason.trim() === '' ? null : form.reason.trim(),
          })
          .then(
            (result) => {
              if (!mounted.current) return;
              if (!result.ok) {
                const text =
                  result.error.code === 'validation_failed'
                    ? E.actions.full
                    : errorCopy(result.error).text;
                notify('actions', { text, tone: 'red' });
                return;
              }
              updateLocal((x) => ({ ...x, templateName: null }));
              notify('actions', { text: E.actions.saved(name.trim()), tone: 'green' });
            },
            () => undefined,
          );
      },
      block: () => {
        if (view.problem) return;
        confirmDraft(local().form);
      },
      applyTemplate: (id) => {
        const s = api.getState();
        const template = s.snapshot.templates.find((t) => t.id === id);
        if (!template) return;
        updateForm(() => draftFromTemplate(template, s.snapshot.prefs));
        setPickedFor(s.env.detail);
        scrollToSection('blq-targets');
      },
      deleteTemplate: (id) => {
        void bridge.invoke('templates:delete', { id }).then(
          (result) => {
            if (mounted.current && !result.ok) {
              notify('templates', { text: errorCopy(result.error).text, tone: 'red' });
            }
          },
          () => undefined,
        );
      },
      toggleSchedule: (id, enabled) => {
        setPendingSchedules((p) => ({ ...p, [id]: enabled }));
        notify('lists', null);
        void bridge.invoke('schedules:set-enabled', { id, enabled }).then(
          (result) => {
            if (!mounted.current) return;
            setPendingSchedules((p) => {
              const next = { ...p };
              delete next[id];
              return next;
            });
            if (!result.ok) {
              notify('lists', { text: errorCopy(result.error).text, tone: 'red' });
              return;
            }
            setSchedules((s) =>
              s.status === 'ready'
                ? { ...s, list: s.list.map((x) => (x.id === id ? result.value : x)) }
                : s,
            );
          },
          () => undefined,
        );
      },
      retrySchedules: () => {
        setSchedules({ status: 'loading' });
        loadSchedules();
      },
      startExam: (minutes) => {
        const s = api.getState();
        const base: BlockDraft = {
          targets: emptyTargets(),
          whitelistOnly: true,
          savedTargets: null,
          mode: 'exam',
          end: { kind: 'duration', minutes },
          reason: local().form.reason || s.snapshot.prefs.lastReason,
        };
        confirmDraft(base);
      },
      customizeExam: () => {
        updateForm((form) => withMode(form, 'exam'));
        scrollToSection('blq-targets');
      },
      openEmergency: () =>
        bridge.send('window:open-detail', { name: 'emergencia', blockIds: null }),
    };
  }, [
    api,
    bridge,
    notify,
    announce,
    updateLocal,
    updateForm,
    updateTargets,
    loadSchedules,
    loadLimits,
    loadSettings,
    view,
  ]);

  return { view, local: detail.bloqueos, nowMs, notices, announcement, announce, actions };
}
