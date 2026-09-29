/**
 * Data and actions of the Recompensas window. The shop (`rewards:list`, GET /v1/rewards) is
 * fetched while the window is visible: when it opens, when a door opens it again and when the
 * balance, the lock or the blocks change (a block started or ended, points came in). A redeem
 * (`rewards:redeem`, after the in-place «¿Seguro?») reuses its intent id while retried, so the
 * guardian replays instead of charging twice; the result lives in the detail window's local
 * state (`recompensas.redeemed`, fixture-settable) and the shop is read again.
 *
 * Screen readers: the shop row's polite region (`helpLive`) says the armed «¿Seguro?»; the
 * window's one polite region, mounted empty with it, says the outcome (the redemption, a
 * refusal), which shows on its own line under the shop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RewardsResponse } from '@centrate/shared/guardian-api';
import { newIntentId } from '../../app/push';
import { useNow } from '../../hooks/useNow';
import { useAnnouncer, type Announcement } from '../bloqueos/announcer';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { UiError } from '../../../../shared/ui-state';
import {
  deriveRecompensasView,
  redeemErrorText,
  type LineView,
  type RecompensasView,
} from './view';

export interface RecompensasApi {
  view: RecompensasView;
  /** The shop answered at least once (or failed): the rows or the error can show. */
  ready: boolean;
  /** A request is in flight (e2e and captures wait for it to clear). */
  loading: boolean;
  /** `rewards:list` failed (the retry row shows). */
  loadError: UiError | null;
  /** The offer being redeemed. */
  busy: string | null;
  announcement: Announcement | null;
  redeem(offerId: string): void;
  retry(): void;
  openBloqueos(): void;
}

export function useRecompensas(): RecompensasApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const visible = useAppStore((s) => s.env.visible);
  const request = useAppStore((s) => s.env.detail);
  const state = useAppStore((s) => s.snapshot.state);
  const progress = useAppStore((s) => s.snapshot.progress);
  const redeemed = useAppStore((s) => s.detail.recompensas.redeemed);
  const nowMs = useNow(30_000);

  const [rewards, setRewards] = useState<RewardsResponse | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(() => (api.getState().env.visible ? 1 : 0));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<LineView | null>(null);
  const [reload, setReload] = useState(0);
  const { announcement, announce } = useAnnouncer();
  /** One key per offer while its redeem is retried. */
  const intents = useRef(new Map<string, string>());

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // What the shop depends on: the balance, the lock, the blocks and the open breaks.
  const shopKey = state
    ? [
        state.points.balance,
        state.rewardsLock ?? '',
        state.blocks.map((b) => b.id).join(','),
        state.allowances.map((a) => `${a.id}:${a.endsAt}`).join(','),
      ].join('|')
    : 'none';

  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    setPending((n) => n + 1);
    const done = (): void => {
      if (mounted.current) setPending((n) => Math.max(0, n - 1));
    };
    void bridge.invoke('rewards:list', null).then(
      (result) => {
        done();
        if (!live || !mounted.current) return;
        if (result.ok) {
          setRewards(result.value);
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
  }, [bridge, visible, request, shopKey, reload]);

  // The first answer (or the window hidden before it) ends the initial «loading».
  const initial = useRef(true);
  useEffect(() => {
    if (!initial.current) return;
    initial.current = false;
    setPending((n) => Math.max(0, n - 1));
  }, []);

  // A new door (`ui:detail`) starts clean: no old result or notice.
  const firstDetail = useRef(true);
  useEffect(() => {
    if (firstDetail.current) {
      firstDetail.current = false;
      return;
    }
    setNotice(null);
    api
      .getState()
      .updateDetail((d) =>
        d.recompensas.redeemed ? { ...d, recompensas: { ...d.recompensas, redeemed: null } } : d,
      );
  }, [api, request]);

  const view = useMemo(
    () =>
      deriveRecompensasView({
        snapshot: { state, progress },
        rewards,
        redeemed,
        notice,
        nowMs,
      }),
    [state, progress, rewards, redeemed, notice, nowMs],
  );

  const redeem = useCallback(
    (offerId: string) => {
      if (busy) return;
      const offer = rewards?.offers.find((o) => o.offerId === offerId) ?? null;
      const row = view.rows.find((r) => r.id === offerId);
      if (!row || row.disabledReason) return;
      const intentId = intents.current.get(offerId) ?? newIntentId();
      intents.current.set(offerId, intentId);
      setBusy(offerId);
      setNotice(null);
      void bridge.invoke('rewards:redeem', { intentId, offerId }).then(
        (result) => {
          if (!mounted.current) return;
          setBusy(null);
          if (!result.ok) {
            const text = redeemErrorText(result.error, offer);
            setNotice({ text, tone: 'red' });
            announce(text);
            // The guardian's picture changed (points, lock, blocks): read the shop again.
            if (result.error.kind === 'rejected') setReload((n) => n + 1);
            return;
          }
          intents.current.delete(offerId);
          api.getState().updateDetail((d) => ({
            ...d,
            recompensas: { ...d.recompensas, redeemed: result.value },
          }));
          setReload((n) => n + 1);
        },
        () => {
          if (mounted.current) setBusy(null);
        },
      );
    },
    [api, bridge, busy, rewards, view.rows, announce],
  );

  // The redemption, once it shows, is said once.
  const spoken = useRef(redeemed);
  useEffect(() => {
    if (redeemed === spoken.current) return;
    spoken.current = redeemed;
    if (redeemed && view.result?.tone === 'green') announce(view.result.text);
  }, [redeemed, view.result, announce]);

  return {
    view,
    ready: rewards !== null || loadError !== null,
    loading: pending > 0,
    loadError: rewards === null ? loadError : null,
    busy,
    announcement,
    redeem,
    retry: () => setReload((n) => n + 1),
    openBloqueos: () =>
      bridge.send('window:open-detail', { name: 'bloqueos', seed: null, focus: 'form' }),
  };
}
