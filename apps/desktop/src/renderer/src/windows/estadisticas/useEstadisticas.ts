/**
 * Data and actions of the Estadísticas window. Everything shown comes from main's copy of the
 * guardian's event log (`stats:*`, docs/DESKTOP.md §15.3), fetched while the window is visible:
 * - the overview of the period (`stats:overview`) whenever the range or the anchor changes;
 * - the heatmap (`stats:heatmap`, 53 weeks) and the first page of the log (`stats:events`)
 *   when the window opens and when the filter changes; «Mostrar más» appends older pages;
 * - all of them again when the door is opened again or the points change (a block ended while
 *   the window was open).
 * A refetch keeps the previous answer on screen (`stale`) until the new one arrives: no
 * spinner, no jump. The range, the anchor, the filter and the last export live in the detail
 * window's local state, so fixtures can set them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalDay, PointsSummary } from '@centrate/shared/domain';
import { useNow } from '../../hooks/useNow';
import { useAppStore, useAppStoreApi } from '../../store/context';
import { snapshotFeature, type EstadisticasLocalState } from '../../../../shared/ui-state';
import {
  shiftAnchor,
  type CsvExportKind,
  type EventLogFilter,
  type EventLogPage,
  type StatsHeatmap,
  type StatsOverview,
  type StatsRange,
} from '../../../../shared/stats';
import { localDayOf } from './dates';
import { ESTADISTICAS } from './i18n';
import {
  HEATMAP_WEEKS,
  LOG_PAGE,
  effectiveAnchor,
  exportNotice,
  firstSessionDraft,
  isCurrentPeriod,
} from './view';
import { useAnnouncer, type Announcement } from './announcer';

export interface Loaded<T> {
  /** What the request was for (`range:anchor`, the filter…). */
  key: string;
  data: T;
}

export interface EstadisticasApi {
  local: EstadisticasLocalState;
  today: LocalDay;
  /** The day the period is drawn around (the anchor, else today). */
  anchor: LocalDay;
  points: PointsSummary | null;
  studyEnabled: boolean;
  overview: StatsOverview | null;
  /** The overview on screen belongs to an earlier range or anchor (a refetch is on its way). */
  stale: boolean;
  overviewFailed: boolean;
  heatmap: StatsHeatmap | null;
  log: EventLogPage | null;
  logBusy: boolean;
  /** A request is in flight (e2e and captures wait for it to clear). */
  loading: boolean;
  exporting: CsvExportKind | null;
  /** The tile whose export just finished: its own help says the result while it has focus. */
  lastExport: CsvExportKind | null;
  exportFailed: boolean;
  announcement: Announcement | null;
  setRange(range: StatsRange): void;
  shift(step: -1 | 1): void;
  goToday(): void;
  setFilter(filter: EventLogFilter): void;
  loadMore(): void;
  exportCsv(kind: CsvExportKind): void;
  retry(): void;
  startFirstSession(): void;
}

export function useEstadisticas(): EstadisticasApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const local = useAppStore((s) => s.detail.estadisticas);
  const visible = useAppStore((s) => s.env.visible);
  const request = useAppStore((s) => s.env.detail);
  const points = useAppStore((s) => s.snapshot.state?.points ?? null);
  const features = useAppStore((s) => s.snapshot.features);
  const health = useAppStore((s) => s.snapshot.health);
  const studyEnabled = snapshotFeature({ features, health }, 'study');
  const nowMs = useNow(60_000);

  const today = points?.today.day ?? localDayOf(nowMs);
  const anchor = effectiveAnchor(local.anchor, today);
  // The points move when something that changes the statistics happened.
  const pointsKey = points
    ? `${points.today.day}:${points.balance}:${points.xp}:${points.today.focusMinutes}`
    : 'none';
  const [reload, setReload] = useState(0);
  const refreshKey = `${pointsKey}:${reload}`;

  const [overview, setOverview] = useState<Loaded<StatsOverview> | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [heatmap, setHeatmap] = useState<StatsHeatmap | null>(null);
  const [log, setLog] = useState<Loaded<EventLogPage> | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [exporting, setExporting] = useState<CsvExportKind | null>(null);
  const [lastExport, setLastExport] = useState<CsvExportKind | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const { announcement, announce } = useAnnouncer();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Runs `load` and counts it as in flight until it settles. */
  const track = useCallback(<T>(load: Promise<T>): Promise<T> => {
    setPending((n) => n + 1);
    const done = (): void => {
      if (mounted.current) setPending((n) => Math.max(0, n - 1));
    };
    load.then(done, done);
    return load;
  }, []);

  const overviewKey = `${local.range}:${local.anchor ?? 'today'}`;

  // The period: on open, on every range or anchor change, and when the data may have moved.
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    void track(bridge.invoke('stats:overview', { range: local.range, anchor: local.anchor })).then(
      (result) => {
        if (!live || !mounted.current) return;
        if (result.ok) {
          setOverview({ key: overviewKey, data: result.value });
          setOverviewFailed(false);
        } else {
          setOverviewFailed(true);
        }
      },
      () => {
        if (live && mounted.current) setOverviewFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, track, visible, request, local.range, local.anchor, overviewKey, refreshKey]);

  // The last year, on open and when the data may have moved.
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    void track(bridge.invoke('stats:heatmap', { end: null, weeks: HEATMAP_WEEKS })).then(
      (result) => {
        if (live && mounted.current && result.ok) setHeatmap(result.value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, track, visible, request, refreshKey]);

  // The newest page of the log for the filter.
  const filter = local.eventFilter;
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    void track(bridge.invoke('stats:events', { filter, before: null, limit: LOG_PAGE })).then(
      (result) => {
        if (live && mounted.current && result.ok) setLog({ key: filter, data: result.value });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, track, visible, request, filter, refreshKey]);

  // A door opened again starts without the previous export result.
  const firstRequest = useRef(true);
  useEffect(() => {
    if (firstRequest.current) {
      firstRequest.current = false;
      return;
    }
    setExportFailed(false);
    setLastExport(null);
  }, [request]);

  const update = useCallback(
    (fn: (s: EstadisticasLocalState) => EstadisticasLocalState) =>
      api.getState().updateDetail((d) => ({ ...d, estadisticas: fn(d.estadisticas) })),
    [api],
  );

  const setRange = useCallback(
    (range: StatsRange) => update((s) => (s.range === range ? s : { ...s, range })),
    [update],
  );

  const shift = useCallback(
    (step: -1 | 1) =>
      update((s) => {
        const next = shiftAnchor(s.range, effectiveAnchor(s.anchor, today), step);
        if (next > today) return s;
        return { ...s, anchor: isCurrentPeriod(s.range, next, today) ? null : next };
      }),
    [update, today],
  );

  const goToday = useCallback(() => update((s) => ({ ...s, anchor: null })), [update]);

  const setFilter = useCallback(
    (eventFilter: EventLogFilter) =>
      update((s) => (s.eventFilter === eventFilter ? s : { ...s, eventFilter })),
    [update],
  );

  const shownLog = log && log.key === filter ? log.data : null;
  const loadMore = useCallback(() => {
    const current = shownLog;
    if (!current || current.nextBefore === null || logBusy) return;
    setLogBusy(true);
    void track(
      bridge.invoke('stats:events', { filter, before: current.nextBefore, limit: LOG_PAGE }),
    ).then(
      (result) => {
        if (!mounted.current) return;
        setLogBusy(false);
        if (!result.ok) return;
        setLog((prev) =>
          prev && prev.key === filter && prev.data.nextBefore === current.nextBefore
            ? {
                key: filter,
                data: {
                  entries: [...prev.data.entries, ...result.value.entries],
                  nextBefore: result.value.nextBefore,
                  total: result.value.total || prev.data.total,
                },
              }
            : prev,
        );
      },
      () => {
        if (mounted.current) setLogBusy(false);
      },
    );
  }, [bridge, track, filter, shownLog, logBusy]);

  const exportCsv = useCallback(
    (kind: CsvExportKind) => {
      if (exporting) return;
      setExporting(kind);
      setExportFailed(false);
      void bridge.invoke('stats:export-csv', { kind }).then(
        (result) => {
          if (!mounted.current) return;
          setExporting(null);
          setLastExport(kind);
          if (result.ok) {
            update((s) => ({ ...s, exported: result.value }));
            announce(exportNotice(result.value, false).text);
          } else {
            setExportFailed(true);
            announce(ESTADISTICAS.exports.failed);
          }
        },
        () => {
          if (!mounted.current) return;
          setExporting(null);
          setLastExport(kind);
          setExportFailed(true);
          announce(ESTADISTICAS.exports.failed);
        },
      );
    },
    [bridge, exporting, update, announce],
  );

  const retry = useCallback(() => setReload((n) => n + 1), []);

  const startFirstSession = useCallback(() => {
    const s = api.getState();
    s.bridge.send('window:confirm-draft', {
      draft: firstSessionDraft(s.snapshot.templates, s.snapshot.prefs),
    });
  }, [api]);

  return {
    local,
    today,
    anchor,
    points,
    studyEnabled,
    overview: overview?.data ?? null,
    stale: overview !== null && overview.key !== overviewKey,
    overviewFailed,
    heatmap,
    log: shownLog,
    logBusy,
    loading: pending > 0,
    exporting,
    lastExport,
    exportFailed,
    announcement,
    setRange,
    shift,
    goToday,
    setFilter,
    loadMore,
    exportCsv,
    retry,
    startFirstSession,
  };
}
