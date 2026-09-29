/**
 * Main-owned state of the Phase 5 platform services (docs/DESKTOP.md §15), carried in
 * `UiSnapshot` so every window (and every harness fixture) sees the same thing:
 *
 * - `progress`: the mascot's phase and the achievements count (Progreso header, Logros door);
 * - `updater`: auto-update (footer «Actualizar a v1.3.0», Ajustes › Sistema);
 * - `activeWindow`: the backup layer that reads the foreground window title (PROMPT §5 «Ventana
 *   activa»; macOS needs Screen Recording);
 * - `shortcuts`: which global shortcuts the OS refused;
 * - `osd`: the big notice being shown (G-Helper `ToastForm`), cleared by main after 2 s;
 * - `nuclear`: the Nuclear overlay's liveness (the guardian relaunches the app without it).
 *
 * Plus the payload types of their channels. Pure module: no DOM, Node or Electron imports.
 */
import type { IsoUtc } from '@centrate/shared/domain';
import type { AchievementId, MascotStage } from '@centrate/shared/points';
import type { ShortcutAction } from './prefs';

// ---------------------------------------------------------------------------------------
// Progress: mascot and achievements (PROMPT §7, ARCHITECTURE §6.5)
// ---------------------------------------------------------------------------------------

/**
 * Computed by main from the synced event log (`mascotStage`, `focusMinutesSinceGiveUp`,
 * `achievementMetricsFromEvents`) and `state.points`; `null` until the local log was read.
 */
export interface ProgressState {
  mascot: MascotStage;
  /** Achievements reached / all of them («Logros: 3 de 8»). */
  achieved: number;
  total: number;
  /** Reached since the Logros window was last opened (highlighted there, notified once). */
  fresh: AchievementId[];
}

/** One tile of the Logros grid (`achievements:list`). */
export interface AchievementStatus {
  id: AchievementId;
  achieved: boolean;
  /** Progress for the help line («Llevas 3 de 7 días»). */
  current: number;
  threshold: number;
  /** When it was first reached (display time), if known. */
  achievedAt: IsoUtc | null;
}

// ---------------------------------------------------------------------------------------
// Updater (PROMPT §12, footer and Ajustes › Sistema)
// ---------------------------------------------------------------------------------------

export const UPDATER_STATUSES = [
  /** Not checked yet in this run. */
  'idle',
  'checking',
  /** Running the latest version. */
  'current',
  /** `version` exists; nothing downloaded yet. */
  'available',
  'downloading',
  /** Downloaded: «Reiniciar para actualizar» installs it (blocks stay: the guardian runs apart). */
  'ready',
  'error',
  /** Unpackaged, AppImage without write access, a package manager install… */
  'unsupported',
] as const;
export type UpdaterStatus = (typeof UPDATER_STATUSES)[number];

export interface UpdaterState {
  status: UpdaterStatus;
  /** The newer version (`available`, `downloading`, `ready`). Main mirrors it in `app.updateVersion`. */
  version: string | null;
  /** 0–100 while `downloading`. */
  percent: number | null;
  /** Last finished check (ms). */
  checkedAt: number | null;
  /** Error code of the last failure (`network`, `signature`…), for the help line. */
  error: string | null;
}

export const INITIAL_UPDATER: Readonly<UpdaterState> = Object.freeze({
  status: 'idle',
  version: null,
  percent: null,
  checkedAt: null,
  error: null,
});

// ---------------------------------------------------------------------------------------
// Active window layer (PROMPT §5 capa 4; koffi FFI, no native rebuilds)
// ---------------------------------------------------------------------------------------

export const ACTIVE_WINDOW_STATUSES = [
  /** Not started (no active block, or the feature is off). */
  'off',
  /** Watching the foreground window while a block is active. */
  'ok',
  /** macOS: Screen Recording not granted; the layer is off until it is. */
  'needs-permission',
  /** Wayland or an OS without a way to read the title: the layer is off. */
  'unsupported',
  /** The FFI call failed; retried later. */
  'error',
] as const;
export type ActiveWindowState = (typeof ACTIVE_WINDOW_STATUSES)[number];

export interface ActiveWindowStatus {
  status: ActiveWindowState;
  /** The last title match reported as an attempt (`POST /v1/attempts`, layer `window`). */
  lastMatch: { serviceId: string; at: number } | null;
}

export const INITIAL_ACTIVE_WINDOW: Readonly<ActiveWindowStatus> = Object.freeze({
  status: 'off',
  lastMatch: null,
});

/** `activewin:request-permission` (macOS opens System Settings › Screen Recording). */
export type PermissionOutcome = 'granted' | 'opened-settings' | 'unsupported';

// ---------------------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------------------

export interface ShortcutStatus {
  /** Configured shortcuts the OS refused (taken by another app); Ajustes says so. */
  failed: ShortcutAction[];
}

export const INITIAL_SHORTCUTS: Readonly<ShortcutStatus> = Object.freeze({ failed: [] });

// ---------------------------------------------------------------------------------------
// OSD (PROMPT §10 «Aviso grande»)
// ---------------------------------------------------------------------------------------

/** The OSD's 20 px lucide icon (the text always says what happened). */
export const OSD_ICONS = [
  'extend',
  'block',
  'timer',
  'check',
  'warning',
  'study',
  'awake',
] as const;
export type OsdIcon = (typeof OSD_ICONS)[number];

/** The accent of the icon (the pill itself is always black at 60 % with white text). */
export const OSD_TONES = ['neutral', 'blue', 'orange', 'red', 'green'] as const;
export type OsdTone = (typeof OSD_TONES)[number];

/** `osd:show` from a renderer: main stamps it and shows it only when «Avisos grandes» is on. */
export interface OsdRequest {
  text: string;
  icon: OsdIcon;
  tone: OsdTone;
}

/** The notice on screen (`snapshot.osd`); main clears it `UI_TIMINGS.osdMs` after `shownAt`. */
export interface OsdMessage extends OsdRequest {
  /** Increases per notice (a repeated text still restarts the 2 s). */
  id: number;
  shownAt: number;
}

/** OSD geometry (PROMPT §10): centred, 300 DIP above the work area's bottom edge. */
export const OSD_LAYOUT = Object.freeze({ bottomOffset: 300, radius: 8, fontSize: 28 });

/** Longest OSD text accepted over IPC. */
export const OSD_TEXT_MAX = 80;

// ---------------------------------------------------------------------------------------
// Nuclear overlay (PROMPT §10 «Nuclear», ARCHITECTURE §10.5)
// ---------------------------------------------------------------------------------------

export interface NuclearStatus {
  /** `shown`: a full-screen window covers every display. */
  overlay: 'hidden' | 'shown' | 'unsupported';
  displays: number;
  /** Last accepted `POST /v1/nuclear/heartbeat` (ms). */
  lastHeartbeatAt: number | null;
}

export const INITIAL_NUCLEAR: Readonly<NuclearStatus> = Object.freeze({
  overlay: 'hidden',
  displays: 0,
  lastHeartbeatAt: null,
});

// ---------------------------------------------------------------------------------------
// Running processes (apps autocomplete in Bloqueos)
// ---------------------------------------------------------------------------------------

export interface RunningProcess {
  /** Executable name as the process watcher matches it («Discord.exe»). */
  name: string;
  /** Catalog app it belongs to, when the catalog knows it. */
  appId: string | null;
}

// ---------------------------------------------------------------------------------------
// Sounds, onboarding and camera results
// ---------------------------------------------------------------------------------------

/** `sounds:load`: the loop's WAV bytes (decode with `decodeAudioData`, see the README). */
export interface SoundData {
  bytes: Uint8Array;
  mime: 'audio/wav';
}

/** «Instalar» in onboarding step 2 (same elevation as «Reparar»). */
export type InstallOutcome = 'installed' | 'already-installed' | 'cancelled' | 'unsupported';

/** Onboarding step 4 until Study Mode ships: there is no camera test yet. */
export type CameraTestOutcome = 'unavailable';

/** What an onboarding step shows on the right of its header («No instalado», «Hecho»…). */
export type OnboardingStepStatus = 'todo' | 'done' | 'optional' | 'unavailable';
