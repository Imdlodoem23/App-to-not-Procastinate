/**
 * Smoothing, hysteresis and the ENFOCADO → DUDA → STRIKE state machine (owner: DECISION).
 * Deterministic: time only comes from `TickInput.now`. DESIGN.md §7.5–7.10.
 *
 * Per tick: gap check → phase (with the local pause quota) → observation → presence
 * counters and the absence path → «No te veo» → warm-up → window, score and `low` → eyes →
 * DUDA / strike → credit → hints → timeline and the feedback ring. The engine only decides
 * when to *request* a strike; the guardian decides whether it counts.
 */
import { STUDY_AI_CONSTANTS, resolveStudyAiSettings } from '../config';
import { isDeskPhoneLearner } from '../score/desk-phone';
import type {
  AttentionEngineOptions,
  AttentionEvent,
  AttentionSnapshot,
  AttentionState,
  AttentionTotals,
  ClassifierKind,
  FeedbackEpisodeResult,
  LowCause,
  MonoMs,
  Observation,
  Observer,
  Presence,
  SessionTimeline,
  StrikeAck,
  StrikeCause,
  StudyAiSettings,
  StudyPhase,
  TickInput,
  TickOutput,
  TimelineKind,
} from '../types';
import {
  ABSENT_CONFIRM_MS,
  FAST_RECOVERY_HOLD_MS,
  FAST_RECOVERY_MAX,
  FOCUS_MINUTE_MS,
  FOCUS_MINUTE_SHARE,
  PRESENCE_DEBOUNCE_MS,
} from './constants';
import { DrowsyTracker } from './eyes';
import { FeedbackBook } from './feedback';
import { HintDebouncer } from './hints';
import { PauseQuota, type PauseQuotaStatus } from './pause-quota';
import { TimelineBuilder } from './timeline';
import { ScoreWindow, type WindowScore } from './window';

const C = STUDY_AI_CONSTANTS;

/** States in which the work-phase machine runs. */
function isWorkState(state: AttentionState): boolean {
  return state === 'warmup' || state === 'focused' || state === 'doubt' || state === 'away';
}

/** The classifier kind of a camera observer (duck-typed: the engine accepts any Observer). */
function classifierKindOf(observer: Observer): ClassifierKind | null {
  const classifier = (observer as { readonly classifier?: unknown }).classifier;
  if (typeof classifier !== 'object' || classifier === null) return null;
  const kind = (classifier as { readonly kind?: unknown }).kind;
  return kind === 'personal' || kind === 'generic' ? kind : null;
}

/**
 * Mid-session settings: each field keeps the stricter of the value in use and the requested
 * one (a higher θ, shorter timers, a shorter no-camera idle limit). The smoothing window is
 * neither and stays as the session started. Weaker values wait for the next session, like
 * the guardian delays weakening its own settings: opening Ajustes during a DUDA must not
 * clear it or push the strike back.
 */
function stricterSettings(
  current: Readonly<StudyAiSettings>,
  requested: Readonly<StudyAiSettings>,
): Readonly<StudyAiSettings> {
  return Object.freeze({
    doubtAfterMs: Math.min(current.doubtAfterMs, requested.doubtAfterMs),
    strikeAfterDoubtMs: Math.min(current.strikeAfterDoubtMs, requested.strikeAfterDoubtMs),
    noFaceStrikeMs: Math.min(current.noFaceStrikeMs, requested.noFaceStrikeMs),
    focusScoreThreshold: Math.max(current.focusScoreThreshold, requested.focusScoreThreshold),
    focusWindowMs: current.focusWindowMs,
    noCameraIdleMs: Math.min(current.noCameraIdleMs, requested.noCameraIdleMs),
  });
}

/** Whole work minutes seen, and how many of them were mostly focused. */
export interface FocusMinutes {
  focused: number;
  total: number;
}

const EMPTY_SCORE: WindowScore = Object.freeze({ score: null, fill: 0 });

export class AttentionEngine {
  private settings: Readonly<StudyAiSettings>;
  private observer: Observer;
  private readonly startedAt: MonoMs;

  private state: AttentionState = 'warmup';
  private warmupStart: MonoMs;
  private warmupMs: number = C.warmupMs;
  private lastTickAt: MonoMs;

  // Score
  private readonly scores = new ScoreWindow();
  private longScore: WindowScore = EMPTY_SCORE;
  private shortScore: WindowScore = EMPTY_SCORE;
  private low = false;
  private prevLow = false;
  /** Since when the short score has been at the fast-recovery level (`null`: it is not). */
  private fastSince: MonoMs | null = null;

  // Timers (ms of observed time)
  private lowMs = 0;
  private doubtMs = 0;
  private absentMs = 0;
  private absenceWarned = false;
  /** Raw absent-like run (dropouts included), counted from its first tick. */
  private absentLikeRun = 0;
  /** Time of the current absent-like run not yet confirmed (shorter than 2 s). */
  private pendingAbsentMs = 0;
  /** Presence time since the last confirmed absence (dropouts pause it). */
  private presentRun = 0;
  private cameraLostRun = 0;
  private prevAbsentLike = false;
  private prevPending = false;
  private prevPresent = false;
  private prevLost = false;
  private absentLike = false;
  private graceUntil: MonoMs = Number.NEGATIVE_INFINITY;

  // Low period bookkeeping (strike cause, snapshot cause)
  private lowTotalMs = 0;
  private lowPhoneMs = 0;
  private lowDistractionMs = 0;
  private readonly causeMs = new Map<LowCause, number>();

  // Eyes
  private readonly eyes = new DrowsyTracker();
  private yawns: MonoMs[] = [];
  private prevYawn = false;
  private lastSuggestAt: MonoMs | null = null;

  // Presence shown in the snapshot (debounced)
  private presenceShown: Presence | null = null;
  private presenceCandidate: Presence | null = null;
  private presenceSince: MonoMs = 0;
  private lastCause: LowCause | null = null;

  private readonly hints = new HintDebouncer();
  private readonly timelineBuilder = new TimelineBuilder();
  private readonly feedback = new FeedbackBook();
  private readonly pauses = new PauseQuota();

  private seq = 0;
  private readonly sums: AttentionTotals = {
    focusedMs: 0,
    warnings: 0,
    strikesRequested: 0,
    ticks: 0,
    workMs: 0,
  };
  private minuteObserved = 0;
  private minuteFocused = 0;
  private readonly minutes: FocusMinutes = { focused: 0, total: 0 };

  /** Events produced outside `tick` (observer switch, resume), flushed with the next tick. */
  private pending: AttentionEvent[] = [];

  constructor(options: AttentionEngineOptions) {
    this.settings = resolveStudyAiSettings(options.settings);
    this.observer = options.observer;
    this.startedAt = options.startedAt;
    this.warmupStart = options.startedAt;
    this.lastTickAt = options.startedAt;
  }

  tick(input: TickInput): TickOutput {
    const now = input.now;
    const events: AttentionEvent[] = this.pending;
    this.pending = [];
    this.sums.ticks += 1;

    const prevAt = this.lastTickAt;
    let dt = now - prevAt;
    const gap = !Number.isFinite(dt) || dt < 0 || dt > C.gapResetMs;
    if (gap) {
      // Suspend, frozen renderer, camera restart: time that was not observed is never punished.
      dt = 0;
      this.resetForGap(now, events);
    }
    if (Number.isFinite(now)) this.lastTickAt = now;
    const step = Math.min(dt, C.maxStepMs);

    const phase = this.pauses.step(input.phase, step);
    this.enterPhase(phase, now, events);
    const observation = this.observer.observe(
      phase === input.phase ? input : { ...input, phase },
      this.settings,
    );
    this.showPresence(observation.presence, now);
    if (phase === 'work') this.workTick(now, step, observation, events);

    const kind = this.timelineKind(phase);
    if (kind && !gap) this.timelineBuilder.add(kind, prevAt - this.startedAt, now - this.startedAt);
    this.feedback.push(now, phase === 'work', observation);

    return { snapshot: this.snapshot(), events, observation };
  }

  /** Guardian answer: a non-counted strike (cooldown) extends the grace. */
  strikeResult(ack: StrikeAck, now: MonoMs): void {
    const left = ack.cooldownLeftMs;
    if (left === null || !Number.isFinite(left) || left <= 0) return;
    if (ack.counted || ack.reason === 'cooldown') {
      // The guardian's cooldown never exceeds ours; cap a bogus value so it cannot mute strikes.
      this.graceUntil = Math.max(this.graceUntil, now + Math.min(left, C.strikeGraceMs));
    }
  }

  /** «¡Estaba estudiando!» step 1: the usable frames of the latest episode. */
  feedbackEpisode(now: MonoMs): FeedbackEpisodeResult {
    return this.feedback.episode(now, this.observer.mode, this.settings.doubtAfterMs);
  }

  /**
   * Step 3, after the observer got the retrained classifier: marks the episode used,
   * re-scores the window and clears DUDA only if the new long score is ≥ θ + hysteresis.
   */
  applyFeedback(now: MonoMs, episodeId: number): readonly AttentionEvent[] {
    const used = this.feedback.use(episodeId);
    if (!used) return [];
    const settings = this.settings;
    // A phone lying on the desk misread as «in hand»: the observer ignores it from now on
    // while it stays there, and its phone time no longer names a strike cause.
    if (used.deskPhone && isDeskPhoneLearner(this.observer)) {
      this.observer.vouchDeskPhone(used.deskPhone);
      this.lowPhoneMs = 0;
    }
    this.scores.rescore((sample) =>
      sample.obs ? this.observer.rescore(sample.obs, settings) : sample.value,
    );
    this.refreshScores(this.lastTickAt);
    const events: AttentionEvent[] = [];
    const score = this.longScore.score;
    const cleared = score !== null && score >= settings.focusScoreThreshold + C.hysteresis;
    if (cleared) {
      this.low = false;
      this.prevLow = false;
      if (this.state === 'doubt') {
        this.setState('focused', now, events);
        events.push({ type: 'doubt_cleared', at: now, by: 'feedback' });
        this.lowMs = 0;
        this.doubtMs = 0;
        this.resetLowPeriod();
      }
    }
    return events;
  }

  /**
   * Settings are a snapshot of the session start. Before the first tick they are replaced;
   * after it only stricter values apply at once (`stricterSettings`), weaker ones wait for
   * the next session. Every value is clamped either way.
   */
  setSettings(settings: Readonly<StudyAiSettings>): void {
    const requested = resolveStudyAiSettings(settings);
    this.settings = this.sums.ticks === 0 ? requested : stricterSettings(this.settings, requested);
  }

  /** The settings this engine runs with (after `setSettings` kept only stricter values). */
  get settingsInUse(): Readonly<StudyAiSettings> {
    return this.settings;
  }

  /** Camera ↔ no-camera switch; resets the window and timers (not the totals). */
  setObserver(observer: Observer, now: MonoMs): void {
    this.observer = observer;
    observer.reset();
    this.resetWork();
    if (isWorkState(this.state)) this.enterWarmup(now, C.warmupMs, this.pending);
  }

  /** System resume: same as a gap (timers reset, nothing punished). */
  resume(now: MonoMs): void {
    this.resetForGap(now, this.pending);
    if (Number.isFinite(now)) this.lastTickAt = now;
  }

  snapshot(): AttentionSnapshot {
    const now = this.lastTickAt;
    const s = this.settings;
    const graceLeftMs = Math.max(0, this.graceUntil - now);
    const state = this.state;
    const scoreHidden =
      state === 'warmup' || state === 'break' || state === 'paused' || state === 'ended';

    let doubtInMs: number | null = null;
    let strikeInMs: number | null = null;
    const candidates: number[] = [];
    if (state === 'focused' && this.low) {
      doubtInMs = graceLeftMs + Math.max(0, s.doubtAfterMs - this.lowMs);
      candidates.push(doubtInMs + s.strikeAfterDoubtMs);
    }
    if (state === 'doubt') {
      candidates.push(graceLeftMs + Math.max(0, s.strikeAfterDoubtMs - this.doubtMs));
    }
    if (isWorkState(state) && this.absentLike) {
      candidates.push(graceLeftMs + Math.max(0, s.noFaceStrikeMs - this.absentMs));
    }
    if (candidates.length > 0) strikeInMs = Math.min(...candidates);

    return {
      at: now,
      mode: this.observer.mode,
      state,
      score: scoreHidden ? null : this.longScore.score,
      low: this.low,
      presence:
        this.presenceShown ?? (this.observer.mode === 'camera' ? 'camera_lost' : 'no_camera'),
      cause: this.low ? (this.dominantCause() ?? this.lastCause) : null,
      drowsy: this.eyes.drowsy,
      classifier: classifierKindOf(this.observer),
      graceLeftMs,
      doubtInMs,
      strikeInMs,
      hints: this.hints.list(),
    };
  }

  totals(): AttentionTotals {
    return { ...this.sums };
  }

  timeline(): SessionTimeline {
    return this.timelineBuilder.build(this.lastTickAt - this.startedAt);
  }

  /** Local view of the pause quota (the guardian's answer is the one that counts). */
  pauseStatus(): PauseQuotaStatus {
    return this.pauses.status();
  }

  /**
   * Whole work minutes observed, and how many were focused: a minute counts when more than
   * half of it was credited as focused (score above the threshold, present, not drowsy).
   */
  focusMinutes(): FocusMinutes {
    return { ...this.minutes };
  }

  // -------------------------------------------------------------------------------------
  // Phases, resets
  // -------------------------------------------------------------------------------------

  private enterPhase(phase: StudyPhase, now: MonoMs, events: AttentionEvent[]): void {
    const target: AttentionState | null =
      phase === 'break'
        ? 'break'
        : phase === 'paused'
          ? 'paused'
          : phase === 'ended'
            ? 'ended'
            : null;
    if (target) {
      if (this.state !== target) {
        this.setState(target, now, events);
        this.resetWork();
        this.observer.reset();
        events.push(...this.hints.clear(now));
      }
      return;
    }
    if (!isWorkState(this.state)) {
      this.resetWork();
      this.observer.reset();
      this.enterWarmup(now, C.warmupMs, events);
    }
  }

  private resetForGap(now: MonoMs, events: AttentionEvent[]): void {
    this.resetWork();
    this.observer.reset();
    if (isWorkState(this.state)) this.enterWarmup(now, C.warmupMs, events);
  }

  /** Windows, low, timers, eyes and the absence path; grace, totals and episodes stay. */
  private resetWork(): void {
    this.scores.clear();
    this.longScore = EMPTY_SCORE;
    this.shortScore = EMPTY_SCORE;
    this.low = false;
    this.prevLow = false;
    this.fastSince = null;
    this.lowMs = 0;
    this.doubtMs = 0;
    this.absentMs = 0;
    this.absenceWarned = false;
    this.absentLikeRun = 0;
    this.pendingAbsentMs = 0;
    this.presentRun = 0;
    this.cameraLostRun = 0;
    this.prevAbsentLike = false;
    this.prevPending = false;
    this.prevPresent = false;
    this.prevLost = false;
    this.absentLike = false;
    this.eyes.reset();
    this.yawns = [];
    this.prevYawn = false;
    this.resetLowPeriod();
  }

  private enterWarmup(now: MonoMs, ms: number, events: AttentionEvent[]): void {
    this.setState('warmup', now, events);
    this.warmupStart = now;
    this.warmupMs = ms;
  }

  private setState(to: AttentionState, now: MonoMs, events: AttentionEvent[]): void {
    if (this.state === to) return;
    events.push({ type: 'state', at: now, from: this.state, to });
    this.state = to;
  }

  // -------------------------------------------------------------------------------------
  // Work phase
  // -------------------------------------------------------------------------------------

  private workTick(now: MonoMs, step: number, obs: Observation, events: AttentionEvent[]): void {
    const s = this.settings;
    this.sums.workMs += step;
    const inGrace = now < this.graceUntil;
    /** The part of this step after the grace ended (all of it without grace). */
    const free = Math.max(0, Math.min(step, now - this.graceUntil));

    // Presence counters. Each run is counted from its first tick.
    const presence = obs.presence;
    const present = presence === 'visible' || presence === 'hidden';
    const lost = presence === 'camera_lost';
    this.cameraLostRun = lost ? (this.prevLost ? this.cameraLostRun + step : 0) : 0;
    const rawAbsent =
      presence === 'absent' ||
      presence === 'covered' ||
      (lost && this.cameraLostRun >= C.cameraLostMs);
    this.absentLikeRun = rawAbsent ? (this.prevAbsentLike ? this.absentLikeRun + step : 0) : 0;
    // A run shorter than 2 s is a dropout between tracked-face frames: pending, not absent.
    const absentLike = rawAbsent && this.absentLikeRun >= ABSENT_CONFIRM_MS;
    const pending = rawAbsent && !absentLike;
    this.absentLike = absentLike;
    // Presence time: a dropout pauses it, a confirmed absence or a lost camera breaks it.
    if (present) {
      if (this.prevPresent) this.presentRun += step;
      else if (!this.prevPending) this.presentRun = 0;
    } else if (!pending) {
      this.presentRun = 0;
    }

    // Absence accumulator: a confirmed run counts from its first absent frame; it resets only
    // after 10 s of presence (dropouts shorter than 2 s neither count nor break it).
    if (rawAbsent) {
      if (this.prevAbsentLike) this.pendingAbsentMs += free;
      if (absentLike) {
        this.absentMs += this.pendingAbsentMs;
        this.pendingAbsentMs = 0;
      }
    } else {
      this.pendingAbsentMs = 0;
      if (present && this.presentRun >= C.absenceResetMs) {
        this.absentMs = 0;
        this.absenceWarned = false;
      }
    }
    if (inGrace) {
      this.absentMs = 0;
      this.pendingAbsentMs = 0;
    }

    // «No te veo»
    if (
      (this.state === 'warmup' || this.state === 'focused' || this.state === 'doubt') &&
      absentLike &&
      this.absentLikeRun >= C.awayEnterMs
    ) {
      this.setState('away', now, events);
      this.low = false;
      this.prevLow = false;
      this.lowMs = 0;
      this.doubtMs = 0;
      this.resetLowPeriod();
      this.eyes.reset();
      this.feedback.open('away', now);
    } else if (this.state === 'away' && present && this.presentRun >= C.presentConfirmMs) {
      this.scores.clear();
      this.low = false;
      this.prevLow = false;
      this.fastSince = null;
      this.enterWarmup(now, C.returnWarmupMs, events);
    }
    if (this.state === 'warmup' && now - this.warmupStart >= this.warmupMs) {
      this.setState('focused', now, events);
    }

    // Window, score and `low` (hysteresis).
    if (this.state !== 'away' && obs.study !== null) {
      this.scores.push(now, obs.study, obs.weight, obs, step);
    }
    this.refreshScores(now);
    this.updateLow(now);

    // Eyes: drowsiness and yawns suggest a break, never a strike. A hidden frame is judged
    // when the observer marks it as a drowsy candidate (head down on the desk, still); while
    // drowsy, any other hidden frame (moving again, turned) counts as awake.
    if (this.state !== 'away') {
      const judged =
        presence === 'visible' || (presence === 'hidden' && (obs.eyes.closed || this.eyes.drowsy));
      const entered = this.eyes.update(now, step, judged, obs.eyes.closed);
      if (entered) this.suggestBreak('eyes_closed', now, events);
    }
    const yawn = obs.eyes.yawn;
    if (yawn && !this.prevYawn) this.yawns.push(now);
    this.prevYawn = yawn;
    while (this.yawns.length > 0 && now - (this.yawns[0] as MonoMs) > C.yawnWindowMs)
      this.yawns.shift();
    if (this.yawns.length >= C.yawnsForBreak) {
      this.suggestBreak('yawning', now, events);
      this.yawns = [];
    }

    // ENFOCADO → DUDA → STRIKE. Drowsy and unknown presence (a lost camera, a dropout)
    // freeze the timers; absence has priority (its own path below). Drowsiness freezes them
    // only when it is the whole story: a pushed frame with a phone in use or a distraction
    // app in the foreground is judged (glasses glare or heavy lids must not hide a phone).
    const drowsy = this.eyes.drowsy;
    const judgedAnyway = obs.study !== null && (obs.evidence.phone || obs.evidence.distractionApp);
    const frozen = (drowsy && !judgedAnyway) || rawAbsent || lost;
    if (this.state === 'focused') {
      if (!frozen) {
        if (!this.low) {
          this.lowMs = 0;
          this.resetLowPeriod();
        } else if (this.prevLow) {
          this.lowMs += free;
          this.accumulateLow(obs, free);
        } else {
          this.lowMs = 0;
          this.resetLowPeriod();
        }
      }
      if (inGrace) this.lowMs = 0;
      if (this.low && !frozen && !inGrace && this.lowMs >= s.doubtAfterMs) {
        this.setState('doubt', now, events);
        this.doubtMs = 0;
        this.warn('doubt', now, events);
        this.feedback.open('doubt', now);
      }
    } else if (this.state === 'doubt') {
      if (!this.low) {
        this.setState('focused', now, events);
        events.push({ type: 'doubt_cleared', at: now, by: 'score' });
        this.lowMs = 0;
        this.doubtMs = 0;
        this.resetLowPeriod();
      } else if (!frozen) {
        this.doubtMs = inGrace ? 0 : this.doubtMs + free;
        this.accumulateLow(obs, free);
        if (this.doubtMs >= s.strikeAfterDoubtMs) {
          this.strike(this.doubtStrikeCause(), now, events);
          this.setState('focused', now, events);
        }
      }
    }

    // Absence path: a warning at half the time, a strike at the full time.
    if (absentLike && !inGrace) {
      if (!this.absenceWarned && this.absentMs >= s.noFaceStrikeMs / 2) {
        this.absenceWarned = true;
        this.warn('absent', now, events);
      }
      if (this.absentMs >= s.noFaceStrikeMs) {
        this.strike('no_face', now, events);
        if (this.state === 'doubt') this.setState('focused', now, events);
      }
    }

    // Credit: the grace does not stop it.
    const credited =
      (this.state === 'warmup' || this.state === 'focused') && !this.low && !drowsy && !absentLike
        ? step
        : 0;
    this.sums.focusedMs += credited;
    this.countMinute(step, credited);

    events.push(...this.hints.update(now, obs.hints));
    if (obs.cause !== null) this.lastCause = obs.cause;

    this.prevAbsentLike = rawAbsent;
    this.prevPending = pending;
    this.prevPresent = present;
    this.prevLost = lost;
    this.prevLow = this.low;
  }

  private refreshScores(now: MonoMs): void {
    const s = this.settings;
    this.scores.prune(now, Math.max(s.focusWindowMs, C.shortWindowMs));
    this.longScore = this.scores.score(now, s.focusWindowMs);
    this.shortScore = this.scores.score(now, C.shortWindowMs);
  }

  private updateLow(now: MonoMs): void {
    const theta = this.settings.focusScoreThreshold;
    const long = this.longScore.score;
    const short = this.shortScore.score;
    const fast =
      short !== null && short >= Math.min(theta + C.fastRecoveryMargin, FAST_RECOVERY_MAX);
    if (!fast) this.fastSince = null;
    else if (this.fastSince === null) this.fastSince = now;
    const fastHeld = this.fastSince !== null && now - this.fastSince >= FAST_RECOVERY_HOLD_MS;
    if (this.low) {
      if ((long !== null && long >= theta + C.hysteresis) || fastHeld) this.low = false;
    } else if (
      this.state !== 'warmup' &&
      this.state !== 'away' &&
      long !== null &&
      long < theta &&
      this.longScore.fill >= C.minWindowFill &&
      !fast
    ) {
      this.low = true;
    }
  }

  private warn(kind: 'doubt' | 'absent', now: MonoMs, events: AttentionEvent[]): void {
    this.sums.warnings += 1;
    events.push({ type: 'warning', at: now, kind });
    this.timelineBuilder.mark('warning', now - this.startedAt, null);
  }

  private strike(cause: StrikeCause, now: MonoMs, events: AttentionEvent[]): void {
    this.seq += 1;
    this.sums.strikesRequested += 1;
    this.graceUntil = now + C.strikeGraceMs;
    events.push({ type: 'strike', at: now, cause, seq: this.seq });
    this.timelineBuilder.mark('strike', now - this.startedAt, cause);
    this.feedback.open('strike', now);
    this.lowMs = 0;
    this.doubtMs = 0;
    this.absentMs = 0;
    this.absenceWarned = false;
    this.resetLowPeriod();
  }

  private suggestBreak(
    reason: 'eyes_closed' | 'yawning',
    now: MonoMs,
    events: AttentionEvent[],
  ): void {
    if (this.lastSuggestAt !== null && now - this.lastSuggestAt < C.breakSuggestEveryMs) return;
    this.lastSuggestAt = now;
    events.push({ type: 'suggest_break', at: now, reason });
    this.timelineBuilder.mark('suggest_break', now - this.startedAt, null);
  }

  private accumulateLow(obs: Observation, ms: number): void {
    if (ms <= 0) return;
    this.lowTotalMs += ms;
    if (obs.evidence.phone) this.lowPhoneMs += ms;
    if (obs.evidence.distractionApp) this.lowDistractionMs += ms;
    if (obs.cause !== null) this.causeMs.set(obs.cause, (this.causeMs.get(obs.cause) ?? 0) + ms);
  }

  private resetLowPeriod(): void {
    if (this.lowTotalMs === 0 && this.causeMs.size === 0) return;
    this.lowTotalMs = 0;
    this.lowPhoneMs = 0;
    this.lowDistractionMs = 0;
    this.causeMs.clear();
  }

  /** §7.7: phone evidence ≥ 40 % → phone; else distraction app ≥ 40 %; else a timeout. */
  private doubtStrikeCause(): StrikeCause {
    const total = this.lowTotalMs;
    if (total <= 0) return 'doubt_timeout';
    if (this.lowPhoneMs / total >= C.causeShare) return 'phone';
    if (this.lowDistractionMs / total >= C.causeShare) return 'distraction_app';
    return 'doubt_timeout';
  }

  private dominantCause(): LowCause | null {
    let best: LowCause | null = null;
    let bestMs = 0;
    for (const [cause, ms] of this.causeMs) {
      if (ms > bestMs) {
        best = cause;
        bestMs = ms;
      }
    }
    return best;
  }

  private countMinute(step: number, credited: number): void {
    let left = step;
    let focus = credited;
    while (left > 0) {
      const room = FOCUS_MINUTE_MS - this.minuteObserved;
      const part = Math.min(left, room);
      const focusPart = Math.min(focus, part);
      this.minuteObserved += part;
      this.minuteFocused += focusPart;
      left -= part;
      focus -= focusPart;
      if (this.minuteObserved >= FOCUS_MINUTE_MS) {
        this.minutes.total += 1;
        if (this.minuteFocused > FOCUS_MINUTE_SHARE * FOCUS_MINUTE_MS) this.minutes.focused += 1;
        this.minuteObserved = 0;
        this.minuteFocused = 0;
      }
    }
  }

  private showPresence(raw: Presence, now: MonoMs): void {
    if (this.presenceShown === null) {
      this.presenceShown = raw;
      this.presenceCandidate = raw;
      this.presenceSince = now;
      return;
    }
    if (raw !== this.presenceCandidate) {
      this.presenceCandidate = raw;
      this.presenceSince = now;
    }
    if (raw !== this.presenceShown && now - this.presenceSince >= PRESENCE_DEBOUNCE_MS) {
      this.presenceShown = raw;
    }
  }

  private timelineKind(phase: StudyPhase): TimelineKind | null {
    switch (phase) {
      case 'break':
        return 'break';
      case 'paused':
        return 'paused';
      case 'ended':
        return null;
      case 'work':
        if (this.state === 'away') return 'away';
        if (this.state === 'doubt') return 'doubt';
        if (this.eyes.drowsy) return 'drowsy';
        if (this.low) return 'low';
        return 'focused';
    }
  }
}
