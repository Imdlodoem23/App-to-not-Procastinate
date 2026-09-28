/**
 * The mini timer (PROMPT §5, §10 «Mini temporizador»), pure: 180×44, the icon of what is
 * blocked, the time at 20 px and the camera dot, from the snapshot alone.
 *
 * - The countdown is the one section 2 shows big: the primary block (latest end), a
 *   punishment included. Its icon is the first service's (favicon or monogram), else a glyph:
 *   the lock (categories, domains, apps), the graduation cap (exam / whitelist) or the shield
 *   (a punishment).
 * - With nothing to count down it says why in a few words, like the tray: «Sin bloqueos»,
 *   «Comprobando…» (boot hold), «Guardián detenido» (never a countdown of blocks nobody
 *   enforces), «Sin guardián», «Conectando…».
 * - The camera dot joins with Study Mode (its flag and a session with the camera on).
 */
import { getService } from '@centrate/shared/catalog';
import type { Block, IsoUtc } from '@centrate/shared/domain';
import { catalogFavicon } from '@centrate/shared/service-icon';
import { modeLabel, targetsLabel } from '../../../../shared/format';
import {
  activePunishment,
  isBootHold,
  primaryBlock,
  snapshotFeature,
  type UiSnapshot,
} from '../../../../shared/ui-state';
import { MINI_TIMER } from './i18n';

export type MiniTimerKind = 'block' | 'punishment' | 'idle' | 'checking' | 'connecting' | 'down';

/** Glyphs of what is not a catalog service (lucide, mapped in the component). */
export type MiniTimerGlyph = 'lock' | 'exam' | 'punishment' | 'idle' | 'down';

export type MiniTimerIcon =
  | { kind: 'service'; serviceId: string; monogram: string; favicon: string | null }
  | { kind: 'glyph'; glyph: MiniTimerGlyph };

export interface MiniTimerView {
  kind: MiniTimerKind;
  icon: MiniTimerIcon;
  /** What the time belongs to, for screen readers; `null` when `text` already says it. */
  label: string | null;
  /** The countdown's end (`block`, `punishment`); `null` otherwise. */
  endsAt: IsoUtc | null;
  /** The few words in place of the countdown; `null` while it counts down. */
  text: string | null;
  /** `muted` for the resting states, `red` when the guardian is not protecting. */
  textTone: 'muted' | 'red' | null;
  /** Study Mode with the camera on: the red dot (with its text for screen readers). */
  camera: boolean;
}

/** The block's icon: the first service's, else a glyph for what it blocks. */
export function blockIcon(block: Block): MiniTimerIcon {
  if (block.kind === 'punishment') return { kind: 'glyph', glyph: 'punishment' };
  if (block.whitelistOnly || block.mode === 'exam') return { kind: 'glyph', glyph: 'exam' };
  for (const id of block.targets.serviceIds) {
    const service = getService(id);
    if (service) {
      return {
        kind: 'service',
        serviceId: service.id,
        monogram: service.monogram,
        favicon: catalogFavicon(service),
      };
    }
  }
  return { kind: 'glyph', glyph: 'lock' };
}

function cameraOn(snapshot: UiSnapshot): boolean {
  const study = snapshot.state?.study ?? null;
  return (
    snapshotFeature(snapshot, 'study') &&
    study !== null &&
    study.camera &&
    (study.status === 'active' || study.status === 'paused')
  );
}

function resting(
  kind: MiniTimerKind,
  glyph: MiniTimerGlyph,
  text: string,
  textTone: 'muted' | 'red',
  camera: boolean,
): MiniTimerView {
  return {
    kind,
    icon: { kind: 'glyph', glyph },
    label: null,
    endsAt: null,
    text,
    textTone,
    camera,
  };
}

export function deriveMiniTimerView(snapshot: UiSnapshot, nowMs: number): MiniTimerView {
  const { link, state } = snapshot;
  const camera = cameraOn(snapshot);
  const M = MINI_TIMER;

  if (link.status === 'down') {
    return link.reason === 'not_installed'
      ? resting('down', 'down', M.guardianMissing, 'red', camera)
      : resting('down', 'down', M.guardianStopped, 'red', camera);
  }
  if (!state) return resting('connecting', 'idle', M.connecting, 'muted', camera);
  if (isBootHold(state, nowMs)) return resting('checking', 'lock', M.checking, 'muted', camera);

  const block = primaryBlock(state);
  if (!block) return resting('idle', 'idle', M.idle, 'muted', camera);

  if (block.kind === 'punishment') {
    const punishment =
      state.punishments.find((p) => p.blockId === block.id) ?? activePunishment(state);
    return {
      kind: 'punishment',
      icon: blockIcon(block),
      label: M.punishment(M.punishmentLevel[punishment?.level ?? 'distractions']),
      endsAt: block.endsAt,
      text: null,
      textTone: null,
      camera,
    };
  }

  return {
    kind: 'block',
    icon: blockIcon(block),
    label: M.block(targetsLabel(block.targets, block.whitelistOnly, 2), modeLabel(block.mode)),
    endsAt: block.endsAt,
    text: null,
    textTone: null,
    camera,
  };
}
