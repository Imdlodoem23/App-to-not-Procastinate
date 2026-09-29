/**
 * What the tray and the main window's title show (docs/DESKTOP.md §8.6, PROMPT §10
 * «Bandeja y otras superficies»). Pure: a function of the snapshot and «now».
 *
 * - Icon: monochrome at rest; blue / orange / red by the strongest active block (punishment,
 *   Hardcore and Examen are red); green in Study Mode (flag); a red dot while the camera is on.
 *   Nothing is enforced while the guardian is down, so the icon says so by going idle.
 * - Tooltip: «Céntrate · YouTube · quedan 43 min · 1.240 pts».
 * - Title: «Céntrate», «Céntrate · quedan 42 min», «Céntrate · castigo 38 min».
 * - Menu: the tiles again (status, Ampliar ▸, Bloqueo rápido ▸, the «Mini temporizador»
 *   checkbox with its flag, «Mantener despierto ▸» with the guardian's `keep_awake`, Abrir,
 *   Salir). While a Nuclear punishment is trusted
 *   (`nuclearTrusted`) «Salir» gives way to «Salida de emergencia…»: quitting would only drop
 *   the overlay until the guardian relaunches the app, and keyboard users need a way out.
 *
 * Remaining minutes round **up**, like everywhere else (decision 10).
 */
import type { Block } from '@centrate/shared/domain';
import type { TrayMenuItemModel } from '../contracts';
import { featureEnabled } from '../../shared/features';
import {
  KEEP_AWAKE_CHOICES,
  keepAwakeAvailable,
  keepAwakeChoiceLabel,
  keepAwakeChoiceOf,
  keepAwakeIsOn,
  keepAwakeOf,
  keepAwakeTrouble,
  keepAwakeUntilLabel,
  type KeepAwakeChoice,
} from '../../shared/keep-awake';
import { SHARED } from '../../shared/i18n';
import {
  formatMinutes,
  formatPointsShort,
  formatRemaining,
  remainingMinutes,
  targetsLabel,
} from '../../shared/format';
import {
  EXTEND_PRESETS,
  activePunishment,
  isBootHold,
  maxExtendMinutes,
  templateLabel,
  primaryBlock,
  type UiSnapshot,
} from '../../shared/ui-state';
import { nuclearTrusted } from '../windows/nuclear-lock';
import type { TrayIconKey } from './icons';
import { TRAY, capitalise } from './i18n';

/** Windows truncates tooltips at 127 UTF-16 units (`NOTIFYICONDATA.szTip`). */
export const TOOLTIP_MAX = 127;
/** Fires just after the minute shown changes. */
const FLIP_EPSILON_MS = 50;
const MINUTE = 60_000;

export interface TrayIconState {
  key: TrayIconKey;
  camera: boolean;
}

export interface TrayView {
  icon: TrayIconState;
  tooltip: string;
  /** Main window title. */
  title: string;
  /** macOS `tray.setTitle` next to the icon («43 min»); empty otherwise. */
  macTitle: string;
  menu: TrayMenuItemModel[];
}

/** Menu item ids (the controller dispatches on them; e2e clicks them by id). */
export const TRAY_ITEM = {
  status: 'status',
  extend: 'extend',
  extendBy: (minutes: number): string => `extend:${minutes}`,
  quick: 'quick',
  template: (id: string): string => `template:${id}`,
  miniTimer: 'mini-timer',
  keepAwake: 'keep-awake',
  /** «30 min» … «Hasta que lo desactive» (`keep-awake:forever`). */
  keepAwakeFor: (choice: KeepAwakeChoice): string => `keep-awake:${choice ?? 'forever'}`,
  keepAwakeOff: 'keep-awake:off',
  open: 'open',
  quit: 'quit',
  emergency: 'emergency',
} as const;

export type TrayAction =
  | { type: 'extend'; minutes: number }
  | { type: 'template'; templateId: string }
  /** The «Mini temporizador» checkbox: show or hide it. */
  | { type: 'mini-timer' }
  /** «Mantener despierto ▸» (also the footer chip's menu): on for that long, or off. */
  | { type: 'keep-awake'; choice: KeepAwakeChoice | 'off' }
  | { type: 'open' }
  | { type: 'quit' }
  /** «Salida de emergencia…» (Nuclear): Emergencia above the overlay. */
  | { type: 'emergency' };

/** Inverse of the ids above; `null` for items that do nothing (status, separators, submenus). */
export function trayActionForItem(id: string): TrayAction | null {
  if (id === TRAY_ITEM.open) return { type: 'open' };
  if (id === TRAY_ITEM.quit) return { type: 'quit' };
  if (id === TRAY_ITEM.emergency) return { type: 'emergency' };
  if (id === TRAY_ITEM.miniTimer) return { type: 'mini-timer' };
  if (id === TRAY_ITEM.keepAwakeOff) return { type: 'keep-awake', choice: 'off' };
  const awake = /^keep-awake:(forever|\d{1,4})$/.exec(id);
  if (awake?.[1]) {
    const choice = awake[1] === 'forever' ? null : Number(awake[1]);
    if (KEEP_AWAKE_CHOICES.includes(choice)) return { type: 'keep-awake', choice };
  }
  const extend = /^extend:(\d{1,4})$/.exec(id);
  if (extend?.[1]) return { type: 'extend', minutes: Number(extend[1]) };
  if (id.startsWith('template:') && id.length > 'template:'.length) {
    return { type: 'template', templateId: id.slice('template:'.length) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------

type Situation =
  | { kind: 'connecting' }
  | { kind: 'down'; text: string }
  | { kind: 'idle'; points: number }
  | { kind: 'study'; points: number }
  | {
      kind: 'punishment';
      remainingMs: number;
      points: number;
    }
  | {
      kind: 'blocks';
      blocks: Block[];
      primary: Block;
      remainingMs: number;
      bootHold: boolean;
      points: number;
    };

function situation(snapshot: UiSnapshot, nowMs: number): Situation {
  const { link, state } = snapshot;
  if (link.status === 'down') {
    return { kind: 'down', text: TRAY.linkDown[link.reason ?? 'unreachable'] };
  }
  if (!state) return { kind: 'connecting' };
  const points = state.points.balance;
  const punishment = activePunishment(state);
  if (punishment) {
    return { kind: 'punishment', remainingMs: Date.parse(punishment.endsAt) - nowMs, points };
  }
  const primary = primaryBlock(state);
  if (primary) {
    return {
      kind: 'blocks',
      blocks: state.blocks,
      primary,
      remainingMs: Date.parse(primary.endsAt) - nowMs,
      bootHold: isBootHold(state, nowMs),
      points,
    };
  }
  const studying =
    state.study !== null &&
    featureEnabled(snapshot.features, 'study', snapshot.health?.capabilities ?? null);
  return studying ? { kind: 'study', points } : { kind: 'idle', points };
}

function strongestKey(blocks: readonly Block[]): TrayIconKey {
  let key: TrayIconKey = 'normal';
  for (const b of blocks) {
    if (b.kind === 'punishment' || b.mode === 'hardcore' || b.mode === 'exam') return 'red';
    if (b.mode === 'strict') key = 'strict';
  }
  return key;
}

function iconFor(s: Situation): TrayIconState {
  switch (s.kind) {
    case 'connecting':
    case 'down':
    case 'idle':
      return { key: 'idle', camera: false };
    case 'study':
      // The camera dot joins with Study Mode (Phase 4): the camera window reports it.
      return { key: 'study', camera: false };
    case 'punishment':
      return { key: 'red', camera: false };
    case 'blocks':
      return { key: strongestKey(s.blocks), camera: false };
  }
}

/** What a set of blocks is called in one line: «YouTube, Instagram» or «3 bloqueos». */
function blocksLabel(blocks: readonly Block[], primary: Block): string {
  return blocks.length > 1
    ? TRAY.tooltip.blocks(blocks.length)
    : targetsLabel(primary.targets, primary.whitelistOnly, 2);
}

function join(parts: readonly string[]): string {
  return parts.join(TRAY.separator);
}

function remainingText(s: { remainingMs: number; bootHold?: boolean }): string {
  return s.bootHold || s.remainingMs <= 0
    ? TRAY.tooltip.checkingClock
    : formatRemaining(s.remainingMs);
}

export function trayTooltip(snapshot: UiSnapshot, nowMs: number): string {
  return truncateTooltip(withAwake(tooltipFor(situation(snapshot, nowMs)), snapshot, nowMs));
}

/** «… · despierto hasta las 18:30» while «Mantener despierto» is on (nothing while off). */
function withAwake(tooltip: string, snapshot: UiSnapshot, nowMs: number): string {
  if (!keepAwakeAvailable(snapshot)) return tooltip;
  const state = keepAwakeOf(snapshot);
  if (!keepAwakeIsOn(state, nowMs)) return tooltip;
  const awake =
    keepAwakeTrouble(state) !== null
      ? TRAY.tooltip.awakeFailed
      : TRAY.tooltip.awake(keepAwakeUntilLabel(state));
  return join([tooltip, awake]);
}

function tooltipFor(s: Situation): string {
  const app = TRAY.appName;
  switch (s.kind) {
    case 'connecting':
      return app;
    case 'down':
      return join([app, s.text]);
    case 'idle':
      return join([app, TRAY.tooltip.noBlocks, formatPointsShort(s.points)]);
    case 'study':
      return join([app, TRAY.tooltip.studying, formatPointsShort(s.points)]);
    case 'punishment':
      return join([app, TRAY.tooltip.punishment, remainingText(s), formatPointsShort(s.points)]);
    case 'blocks':
      return join([
        app,
        blocksLabel(s.blocks, s.primary),
        remainingText(s),
        formatPointsShort(s.points),
      ]);
  }
}

export function truncateTooltip(text: string): string {
  return text.length <= TOOLTIP_MAX ? text : `${text.slice(0, TOOLTIP_MAX - 1)}…`;
}

export function windowTitle(snapshot: UiSnapshot, nowMs: number): string {
  return titleFor(situation(snapshot, nowMs));
}

function titleFor(s: Situation): string {
  const app = TRAY.appName;
  switch (s.kind) {
    case 'connecting':
    case 'idle':
      return app;
    case 'down':
      return join([app, s.text]);
    case 'study':
      return join([app, TRAY.title.studying]);
    case 'punishment':
      return s.remainingMs <= 0
        ? join([app, TRAY.title.checkingClock])
        : join([app, TRAY.title.punishment(formatMinutes(remainingMinutes(s.remainingMs)))]);
    case 'blocks':
      return s.bootHold || s.remainingMs <= 0
        ? join([app, TRAY.title.checkingClock])
        : join([app, formatRemaining(s.remainingMs)]);
  }
}

function macTitleFor(s: Situation): string {
  if ((s.kind === 'blocks' || s.kind === 'punishment') && s.remainingMs > 0) {
    if (s.kind === 'blocks' && s.bootHold) return '';
    return formatMinutes(remainingMinutes(s.remainingMs));
  }
  return '';
}

function item(
  id: string,
  label: string,
  options: Partial<Pick<TrayMenuItemModel, 'type' | 'enabled' | 'checked' | 'submenu'>> = {},
): TrayMenuItemModel {
  return {
    id,
    label,
    type: options.type ?? 'normal',
    enabled: options.enabled ?? true,
    checked: options.checked ?? false,
    submenu: options.submenu ?? [],
  };
}

function separator(id: string): TrayMenuItemModel {
  return item(id, '', { type: 'separator' });
}

function statusLabel(s: Situation): string {
  const status = TRAY.menu.status;
  switch (s.kind) {
    case 'connecting':
      return status.connecting;
    case 'down':
      return capitalise(s.text);
    case 'idle':
      return status.noBlocks;
    case 'study':
      return capitalise(TRAY.tooltip.studying);
    case 'punishment':
      return join([status.punishment, remainingText(s)]);
    case 'blocks':
      return s.bootHold || s.remainingMs <= 0
        ? join([status.checkingClock, blocksLabel(s.blocks, s.primary)])
        : join([capitalise(formatRemaining(s.remainingMs)), blocksLabel(s.blocks, s.primary)]);
  }
}

/** Minutes the «Ampliar ▸» entries may add now; 0 hides the submenu. */
export function trayExtendMax(snapshot: UiSnapshot, nowMs: number): number {
  const s = situation(snapshot, nowMs);
  if (s.kind !== 'blocks' || s.bootHold || s.remainingMs <= 0) return 0;
  if (snapshot.link.status !== 'ok') return 0;
  return maxExtendMinutes(s.primary, snapshot.ops, nowMs);
}

export function trayMenu(snapshot: UiSnapshot, nowMs: number): TrayMenuItemModel[] {
  const s = situation(snapshot, nowMs);
  const items: TrayMenuItemModel[] = [
    item(TRAY_ITEM.status, statusLabel(s), { enabled: false }),
    separator('sep-status'),
  ];

  const max = trayExtendMax(snapshot, nowMs);
  const smallest = Math.min(...EXTEND_PRESETS);
  if (max >= smallest) {
    items.push(
      item(TRAY_ITEM.extend, TRAY.menu.extend, {
        type: 'submenu',
        submenu: EXTEND_PRESETS.map((minutes) =>
          item(TRAY_ITEM.extendBy(minutes), TRAY.menu.extendItem(formatMinutes(minutes)), {
            enabled: minutes <= max,
          }),
        ),
      }),
    );
  }

  if (snapshot.templates.length > 0) {
    items.push(
      item(TRAY_ITEM.quick, TRAY.menu.quick, {
        type: 'submenu',
        submenu: snapshot.templates.map((t) => item(TRAY_ITEM.template(t.id), templateLabel(t))),
      }),
    );
  }
  // Study Mode ▸ joins here with its flag.
  if (featureEnabled(snapshot.features, 'miniTimer', snapshot.health?.capabilities ?? null)) {
    items.push(
      item(TRAY_ITEM.miniTimer, TRAY.menu.miniTimer, {
        type: 'checkbox',
        checked: snapshot.prefs.miniTimer.visible,
      }),
    );
  }

  if (keepAwakeAvailable(snapshot)) {
    items.push(
      item(TRAY_ITEM.keepAwake, TRAY.menu.keepAwake, {
        type: 'submenu',
        submenu: keepAwakeMenuItems(snapshot, nowMs),
      }),
    );
  }

  items.push(
    separator('sep-actions'),
    item(TRAY_ITEM.open, TRAY.menu.open),
    nuclearTrusted(snapshot, nowMs)
      ? item(TRAY_ITEM.emergency, TRAY.menu.emergency)
      : item(TRAY_ITEM.quit, TRAY.menu.quit),
  );
  return items;
}

/**
 * The «Mantener despierto» choices (the tray submenu and the footer chip's menu): 30 min, 1 h,
 * 2 h, 4 h and «Hasta que lo desactive», the running one checked, then «Desactivar» while on.
 * Choosing the running one again changes nothing (the countdown keeps going).
 */
export function keepAwakeMenuItems(snapshot: UiSnapshot, nowMs: number): TrayMenuItemModel[] {
  const current = keepAwakeChoiceOf(keepAwakeOf(snapshot), nowMs);
  const items = KEEP_AWAKE_CHOICES.map((choice) =>
    item(TRAY_ITEM.keepAwakeFor(choice), keepAwakeChoiceLabel(choice), {
      type: 'checkbox',
      checked: current !== undefined && current === choice,
    }),
  );
  if (current !== undefined) {
    items.push(separator('sep-keep-awake'), item(TRAY_ITEM.keepAwakeOff, SHARED.keepAwake.turnOff));
  }
  return items;
}

export function trayView(snapshot: UiSnapshot, nowMs: number): TrayView {
  const s = situation(snapshot, nowMs);
  return {
    icon: iconFor(s),
    tooltip: truncateTooltip(withAwake(tooltipFor(s), snapshot, nowMs)),
    title: titleFor(s),
    macTitle: macTitleFor(s),
    menu: trayMenu(snapshot, nowMs),
  };
}

/**
 * Delay until the minute shown in the tooltip, title or menu changes (the ceiling minute of
 * the time left flips), capped at one minute; `null` when nothing shown depends on time.
 */
export function nextTrayRefreshDelay(snapshot: UiSnapshot, nowMs: number): number | null {
  const s = situation(snapshot, nowMs);
  if (s.kind !== 'blocks' && s.kind !== 'punishment') return null;
  if (s.remainingMs <= 0) return null;
  const minutes = remainingMinutes(s.remainingMs);
  const untilFlip = s.remainingMs - (minutes - 1) * MINUTE;
  return Math.min(MINUTE, Math.max(1, untilFlip)) + FLIP_EPSILON_MS;
}
