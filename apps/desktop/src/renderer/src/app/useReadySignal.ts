/**
 * `window:ready` (docs/DESKTOP.md §7.2, §10): after the first render, and in the harness once per
 * load, when both the renderer-local state (`ui:harness`) and the snapshot of that state id
 * have been rendered. Playwright's `harness.load()` resolves on it; `<html data-harness-ready>`
 * carries the id for browser checks. Call it in the component that renders last (the main
 * window shell, or inside the detail window's `Suspense` boundary after the view).
 */
import { useLayoutEffect, useRef } from 'react';
import { useAppStore, useAppStoreApi } from '../store/context';

export function useReadySignal(): void {
  const api = useAppStoreApi();
  const loaded = useAppStore((s) => s.harnessStateId);
  const seq = useAppStore((s) => s.harnessSeq);
  const snapshotState = useAppStore((s) => s.snapshot.harness?.stateId ?? null);
  const reported = useRef<number | null>(null);

  useLayoutEffect(() => {
    const s = api.getState();
    if (loaded === null) {
      if (reported.current !== null) return;
      reported.current = seq;
      s.bridge.send('window:ready', { stateId: null, rev: s.snapshot.rev });
      return;
    }
    if (loaded !== snapshotState || reported.current === seq) return;
    reported.current = seq;
    s.bridge.send('window:ready', { stateId: loaded, rev: s.snapshot.rev });
    document.documentElement.dataset['harnessReady'] = loaded;
  }, [api, loaded, seq, snapshotState]);
}

/** Renders nothing; reports readiness where it is placed. */
export function ReadyProbe(): null {
  useReadySignal();
  return null;
}
