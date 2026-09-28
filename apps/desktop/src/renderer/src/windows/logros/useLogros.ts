/**
 * Data of the Logros window. The grid (`achievements:list`, main's reading of this computer's
 * copy of the event log) is fetched while the window is visible: when it opens, when a door or
 * a notification opens it again, and when main counts a new one (`snapshot.progress.achieved`).
 *
 * Reading the list marks every reached achievement as seen, so main clears
 * `snapshot.progress.fresh` right after: the ones that were new when this door opened (and any
 * reached while it stays open) are kept here, so they still read «Nuevo».
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AchievementId } from '@centrate/shared/points';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { AchievementStatus } from '../../../../shared/platform';
import type { UiError } from '../../../../shared/ui-state';
import { deriveLogrosView, type LogrosView } from './view';

export interface LogrosApi {
  view: LogrosView;
  /** The list answered at least once (or failed): the grid or the error can show. */
  ready: boolean;
  /** A request is in flight (e2e and captures wait for it to clear). */
  loading: boolean;
  /** `achievements:list` failed and nothing was read before (the retry row shows). */
  loadError: UiError | null;
  retry(): void;
}

function union(a: readonly AchievementId[], b: readonly AchievementId[]): AchievementId[] {
  const out = [...a];
  for (const id of b) if (!out.includes(id)) out.push(id);
  return out;
}

export function useLogros(): LogrosApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const visible = useAppStore((s) => s.env.visible);
  const request = useAppStore((s) => s.env.detail);
  const progress = useAppStore((s) => s.snapshot.progress);
  const achievedCount = progress?.achieved ?? null;

  const [list, setList] = useState<AchievementStatus[] | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(() => (api.getState().env.visible ? 1 : 0));
  const [reload, setReload] = useState(0);
  const [fresh, setFresh] = useState<AchievementId[]>(() => progress?.fresh ?? []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new door starts from what is new now; later news while it stays open adds up.
  const firstRequest = useRef(true);
  useEffect(() => {
    if (firstRequest.current) {
      firstRequest.current = false;
      return;
    }
    setFresh(api.getState().snapshot.progress?.fresh ?? []);
  }, [api, request]);
  const freshNow = progress?.fresh;
  useEffect(() => {
    if (freshNow && freshNow.length > 0) setFresh((prev) => union(prev, freshNow));
  }, [freshNow]);

  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    setPending((n) => n + 1);
    const done = (): void => {
      if (mounted.current) setPending((n) => Math.max(0, n - 1));
    };
    void bridge.invoke('achievements:list', null).then(
      (result) => {
        done();
        if (!live || !mounted.current) return;
        if (result.ok) {
          setList(result.value);
          setLoadError(null);
        } else {
          setLoadError(result.error);
        }
      },
      () => done(),
    );
    return () => {
      live = false;
    };
  }, [bridge, visible, request, achievedCount, reload]);

  // The first answer (or the window hidden before it) ends the initial «loading».
  const initial = useRef(true);
  useEffect(() => {
    if (!initial.current) return;
    initial.current = false;
    setPending((n) => Math.max(0, n - 1));
  }, []);

  const focus = request?.name === 'logros' ? request.focus : null;
  const view = useMemo(
    () => deriveLogrosView({ list, progress, fresh, focus }),
    [list, progress, fresh, focus],
  );

  return {
    view,
    ready: list !== null || loadError !== null,
    loading: pending > 0,
    loadError: list === null ? loadError : null,
    retry: () => setReload((n) => n + 1),
  };
}
