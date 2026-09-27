# Céntrate: architecture and guardian contract

This is the reference for how Céntrate's pieces fit together and for the contract between the
guardian and its clients. The product brief is `PROMPT.md` (Spanish); this document is the
engineering contract that implements PROMPT §2–§10.

**Sources of truth.** When this document and the code disagree, the code in `packages/shared`
wins and this document gets fixed.

| What                                                           | Where                                               |
| -------------------------------------------------------------- | --------------------------------------------------- |
| Domain model, event log types                                  | `packages/shared/src/domain.ts`                     |
| HTTP API types, paths, limits, error codes, validators, client | `packages/shared/src/guardian-api.ts`               |
| Point values, rules and the pure ledger                        | `packages/shared/src/points.ts`                     |
| Points parity vectors (TS and Go)                              | `packages/shared/test/fixtures/points-vectors.json` |
| Catalog (services, domains, apps, whitelist)                   | `packages/shared/src/catalog/`                      |
| Trusted clock                                                  | `guardian/internal/clock` (existing `Detector`)     |
| Hosts section                                                  | `guardian/internal/hosts` (existing `Manager`)      |

Section 17 lists the follow-up work this contract requires outside `packages/shared`.

---

## 1. Components

```text
            ┌──────────────────────────── user session (normal user) ───────────────────────────┐
            │                                                                                  │
            │  Electron app (desktop)                         Browser + MV3 extension          │
            │  ┌──────────────┐  IPC   ┌──────────────────┐    ┌────────────────────────────┐   │
            │  │ renderer(s)  │◀──────▶│ main process     │    │ service worker (background)│   │
            │  │ UI, no token │        │ GuardianClient   │    │ GuardianClient (ext token) │   │
            │  └──────────────┘        │ app token        │    │ DNR rules, attempts        │   │
            │  hidden analysis window  │ node:sqlite stats│    │ blocked.html (display only)│   │
            │  (camera AI, no net)     └────────┬─────────┘    └──────────────┬─────────────┘   │
            └───────────────────────────────────┼─────────────────────────────┼─────────────────┘
                                                │ HTTP JSON, 127.0.0.1:47600  │
            ┌───────────────────────────────────▼─────────────────────────────▼─────────────────┐
            │ Guardian (Go, system service, admin/root)                                        │
            │  API ─ engine (single goroutine owns state) ─ event log + state ─ enforcement    │
            │                                   │                    │                         │
            │            trusted clock ◀────────┘                    ├─ hosts section          │
            │            (boot clock, awake clock, network check)    ├─ process watcher        │
            │                                                        └─ Nuclear supervisor     │
            └──────────────────────────────────────────────────────────────────────────────────┘
```

- **Guardian** (`guardian/`, Go 1.26 as pinned in `guardian/go.mod` and DECISIONS.md; nothing
  in this contract depends on the minor version). A system service through
  `kardianos/service`: Windows service `CentrateGuardian` (LocalSystem), macOS LaunchDaemon,
  Linux systemd unit. It is the **single source of truth and authority** for blocks,
  schedules, study sessions, punishments, emergency unlocks, reward allowances, settings
  that affect enforcement or points, and the **points ledger**. It stores state and an
  append-only event log in the system directory (§11), applies the hosts section, kills
  blocked processes and relaunches the app during a Nuclear punishment.
- **Desktop app** (`apps/desktop`). The **main process** is the only guardian client in the
  app: it holds the app token, polls `/v1/state` every 2 s while the window is visible,
  long-polls `/v1/events` for tray notifications while hidden, sends Study Mode heartbeats,
  reports window-title attempts and syncs the event log into its local `node:sqlite`
  statistics database through a cursor. Renderers talk to the main process over typed IPC
  and never see the token.
- **Extension** (`apps/extension`, MV3, Chromium and Firefox). Paired with a 6-digit code
  (§9.3). The background service worker fetches signed rules, maps them to
  `declarativeNetRequest` rules, reports `main_frame` attempts and sends heartbeats.
  `blocked.html` only displays data it receives from the background.
- **Web** (`apps/web`): static; not part of this contract.

The guardian embeds generated data from `packages/shared` (catalog, point rules, API
constants; §12). Clients send **ids** (service, category and app ids) plus validated custom
domains and process names; the guardian resolves them with its embedded catalog. Reward
redemption uses only catalog data, so no client can make the guardian open an arbitrary
host.

---

## 2. Fixed decisions

1. The API has **no operation that ends a block early**, shortens it, edits it or deletes it.
   `/v1/blocks` has create, read and extend (never shorten). The route table in
   `GUARDIAN_ENDPOINTS` is complete; a test asserts it (§15).
2. Loopback only (`127.0.0.1`), `Host` header check, bearer token for everything except
   `/v1/health` and the pairing claim, CORS restricted to the extension origins, strict
   validation (unknown fields rejected), never executing commands built from received data.
3. `endsAt` is stored in trusted UTC; progress is measured against a monotonic clock that
   keeps counting during suspend (§4). Clients compute countdowns as
   `Date.parse(endsAt) - Date.now()`.
4. Point values live **only** in `packages/shared/src/points.ts`; the guardian has a Go port
   of its pure functions and reads the values from embedded generated JSON. Parity is
   proven by the shared vectors.
5. Default port **47600**, configurable only in the admin-owned `config.json`. There is no
   port fallback: a fixed port is what the extension trusts after pairing.

---

## 3. Glossary

| Term             | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| trusted time `T` | `clock.Detector.EffectiveNow()`: advances only with the boot clock; clock changes do not move it |
| wall offset `W`  | `clock.Detector.WallOffset()`: how far the machine's wall clock is from `T`                      |
| display time     | `T + W`: the instant as the machine's clock reads it. Every API timestamp is display time        |
| boot clock       | Monotonic clock that counts during suspend (`BootTime`)                                          |
| awake clock      | Monotonic clock that stops during suspend (`AwakeTime`)                                          |
| epoch            | One continuous event log. Data deletion or an unreadable log starts a new epoch                  |
| batch            | Events committed atomically by one mutation; the last has `txEnd: true`                          |
| detection        | One sighting of a blocked target by one layer; dedupe turns detections into attempts             |

---

## 4. Time model

The guardian reuses the existing `guardian/internal/clock` package unchanged in spirit (see
its `doc.go`). It must not introduce a second clock implementation.

**Clock sources** (existing code):

| OS      | Boot clock (counts during suspend)               | Awake clock                  | Boot id                                                                          |
| ------- | ------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------- |
| Linux   | `CLOCK_BOOTTIME`                                 | `CLOCK_MONOTONIC`            | `/proc/sys/kernel/random/boot_id`                                                |
| macOS   | `CLOCK_MONOTONIC_RAW` (= `mach_continuous_time`) | `CLOCK_UPTIME_RAW`           | `sysctl kern.bootsessionuuid`                                                    |
| Windows | `QueryInterruptTime` (fallback `GetTickCount64`) | `QueryUnbiasedInterruptTime` | `BootId` under `…\Memory Management\PrefetchParameters` (fallback `derived:` id) |

**Detector semantics** (existing, tolerance 60 s, slew 0.1 %):

- `T(m) = baseWall + (m − baseMono)`; `W` is the signed sum of every reported wall jump.
- Each `Tick` computes `diff = wall − (T + W)`. `|diff| > 60 s` is a jump: `Delta = diff` is
  added to `W`, `T` does not move. Smaller disagreements slew `T` by at most 0.1 % of
  elapsed time (NTP noise never produces events).
- Suspend moves wall and boot clocks together: never a jump. `SuspendedFor = Δboot − Δawake`.
- `Restore(snapshot)` resumes `T` across a service restart in the same boot (a clock change
  made while the guardian was stopped is reported as a jump) and, after a reboot, restarts
  `T` from the earlier of `wall` and `wall − savedOffset`, never earlier than the saved `T`.
- `Calibrate(networkTime)` only ever moves `T` **back** (when `T` is ahead by more than the
  tolerance). It never moves `T` forward, because blocks created while `T` lagged would end
  early.

**Storage and conversion.**

- Every deadline (`endsAt`, `readyAt`, allowance ends, pause ends) is stored as trusted UTC.
  A deadline has passed when `!T.Before(deadline)`.
- API responses convert every timestamp to display time: `display = trusted + W`.
  `serverNow` is the guardian's wall clock when it answered.
- Request timestamps (only `CreateBlockRequest.endsAt`, «hasta las 20:30») are display time;
  the guardian converts them: `trusted = endsAt − W`.
- Events store trusted `at` and the `wallOffsetMs` of the moment, so the app's statistics
  can use either.
- When a jump is detected, `W` changes, every display timestamp moves by `Delta` («suma ese
  salto a endsAt y se lo manda a la app»), `stateVersion` and `rulesVersion` increase and a
  `clock_jump` event is written. The countdown keeps showing the real remaining time.

**Local days.** The guardian computes the local day (`YYYY-MM-DD`) in `settings.timezone`
(IANA, embedded tzdata via `import _ "time/tzdata"`) or, when that is `null`, the OS local
zone. Every event carries the `day` of its emission; the ledger is time-zone free (§6).

---

## 5. Domain model

TypeScript definitions: `domain.ts`. All entities are guardian-owned; clients never send a
complete entity back.

### 5.1 Identifiers

`<prefix>_<16–40 characters [0-9A-Za-z]>`, generated from `crypto/rand` (the guardian uses
22 base62 characters, ~131 bits). Prefixes: `blk` block, `sch` schedule, `stu` study
session, `pun` punishment, `emg` emergency, `alw` allowance, `att` attempt, `ext` paired
extension, `ep` epoch. Ids are opaque; `isIdOf(kind, value)` validates them.

### 5.2 Blocks

| Field                                             | Notes                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `kind`                                            | `manual`, `schedule`, `punishment` (guardian-only), `recovered` (§10.8)                                              |
| `mode`                                            | `normal` (emergency 10 min), `strict` (30 min), `hardcore` (none), `exam` (whitelist + none)                         |
| `status`                                          | `active`, `completed`, `cancelled_emergency`                                                                         |
| `targets`                                         | `TargetSpec`: `serviceIds`, `categoryIds`, `appIds`, `customDomains`, `customProcesses`; all `[]` for whitelist-only |
| `whitelistOnly`, `allow`                          | Block everything except the study whitelist (snapshot) plus `allow`                                                  |
| `reason`                                          | «Tu motivo», ≤ 140 characters, `""` when none                                                                        |
| `startsAt`, `endsAt`, `originalEndsAt`, `endedAt` | Display time in responses; trusted internally                                                                        |
| `extendedMinutes`                                 | Sum of extensions                                                                                                    |
| `scheduleId`, `punishmentId`                      | Origin links                                                                                                         |
| `attemptsCounted`                                 | Counted attempts against this block                                                                                  |
| `emergencyEligible`                               | `normal`/`strict` and not already in a pending emergency                                                             |
| `pointsDelta`                                     | Points granted at completion (0 when cancelled), `null` while active                                                 |

Rules:

- **Length.** One rule for create and extend: the remaining time (`endsAt − T`) is always
  within `GUARDIAN_LIMITS.blockMinMinutes`…`blockMaxMinutes` (5 min…24 h) at creation and never
  above 24 h after an extension. More than `longBlockConfirmMinutes` (4 h) needs
  `acknowledgeLong`; hardcore and exam need `acknowledgeNoEmergency` (defence in depth for
  the two-step confirmation card).
- **Resolution.** At creation the guardian resolves targets with the embedded catalog for
  its own OS and stores the resolved domain, excluded-domain and process lists with the
  block (a later catalog update never changes an active block; catalog ids are never
  deleted, only deprecated). Categories add every service in them plus category-wide apps.
- **Custom entries.** Custom domains must be canonical (`isValidDomain`); the guardian adds
  `www.`/apex variants (`expandDomainVariants`). A custom domain equal to or under a
  protected domain (§17) is rejected with `protected_target`. Custom processes must pass
  `isValidProcessName` and must not be protected (`isProtectedProcessName`).
- **Whitelist.** A whitelist-only block takes no targets. Its allow set is the catalog study
  whitelist plus `settings.studyWhitelist` (snapshotted at creation) plus `allow`, plus
  always-allowed hosts. `allow.customDomains` that belong to a catalog service with at least
  one category are rejected with `allow_distraction` (otherwise an exam block that «allows»
  YouTube would still earn points). Exam mode requires `whitelistOnly: true`.
- **Earning.** Only `manual` and `schedule` blocks earn points (`POINT_RULES.earningBlockKinds`).

### 5.3 Schedules

`Schedule`: `name`, `enabled`, `days` (ISO weekdays), `start`/`end` (`HH:MM`; `end <= start`
means overnight), `timezone` (IANA; `"Local"` is rejected), `targets`, `whitelistOnly`,
`allow`, `mode`, `reason`, plus derived `nextOccurrence` and `activeBlockId`. At most 50. Each
occurrence materializes as an independent `schedule` block (§10.3).

### 5.4 Study sessions

`StudySession` carries the task, `plannedMinutes` (5–480), optional Pomodoro
(`workMinutes` 5–120, `breakMinutes` 1–60), `camera`, `status` (`active`, `paused`,
`completed`, `ended_early`, `abandoned`, `punished`), the guardian-computed `phase` (`work`,
`break`, `paused`, `ended`) and `phaseEndsAt`, counters (`activeMinutes`, `focusedMinutes`,
`strikes`, `attempts`), `cooldownUntil`, pause quota (`pausesLeft`,
`nextPauseAvailableAt`), heartbeat bookkeeping, the punishment `policy` snapshotted at start,
and `achieved` («¿Lo has conseguido?»). At most one session exists at a time.

### 5.5 Punishments

`Punishment`: `blockId` (a strict block of kind `punishment`), `sessionId`, `cause`
(`three_strikes`, `abandoned`), `level` (`distractions`, `whitelist`, `nuclear`), `minutes`
(15–120), `startsAt`, `endsAt`, `status`, `endedAt`. **Punishments stack**: each creates its
own block; enforcement is the union. The Nuclear overlay runs while any active punishment
has level `nuclear`. Punishment blocks cannot be extended by clients and earn nothing.

### 5.6 Emergency unlocks

`EmergencyUnlock`: `blockIds` (only `normal`/`strict` blocks, punishments included),
`status` (`counting` → `ready` → `confirmed`, or `cancelled`/`expired`), `countdownMinutes`
(10, or 30 if any targeted block is strict), `requestedAt`, `readyAt`, `confirmBy`,
`penaltyPreview`, `streakDaysAtRisk`, `resolvedAt`, `cancelReason` (`user`, `expired`,
`blocks_ended`, `reboot`). At most one is pending.

### 5.7 Reward allowances

`RewardAllowance`: `offerId`, `serviceId`, total `minutes` and `cost` (redeeming the same
service again extends it), `startedAt`, `endsAt`, `status` (`active`, `expired`, `revoked`),
`refund`. While active it opens exactly that service's **catalog** domains and processes.

### 5.8 Settings

`GuardianSettings` holds only what affects enforcement or points (UI preferences stay in the
app): `timezone`, `dailyGoalMinutes` (15–600, default 60), `attemptPenalties` (default on),
`punishment` (`level`, `minutes`; default `distractions`, 60), `closeBrowsersWithoutExtension`
(default off), `serverTimeCheck` (default **on**), `studyWhitelist` (`extraDomains`,
`extraProcesses`). Defaults: `DEFAULT_GUARDIAN_SETTINGS`.

**Weakening changes wait 24 h** (`settingsWeakeningDelayMs`). A `PUT /v1/settings` applies
strengthening changes at once and turns weakening ones into `PendingSettingChange`s with
`effectiveAt = T + 24 h` (setting a field back to its effective value cancels its pending
change):

| Field                           | Weakening (delayed)                                   | Applies at once             |
| ------------------------------- | ----------------------------------------------------- | --------------------------- |
| `timezone`                      | any change except the first one from `null`           | `null` → zone (first setup) |
| `dailyGoalMinutes`              | lowering                                              | raising                     |
| `attemptPenalties`              | `true` → `false`                                      | `false` → `true`            |
| `punishment.level`              | lower rank (`distractions` < `whitelist` < `nuclear`) | higher rank                 |
| `punishment.minutes`            | shorter                                               | longer                      |
| `closeBrowsersWithoutExtension` | `true` → `false`                                      | `false` → `true`            |
| `serverTimeCheck`               | `true` → `false`                                      | `false` → `true`            |
| `studyWhitelist`                | any entry added (the whole field waits)               | only removals               |

Study sessions snapshot the punishment policy at start, and whitelist blocks snapshot the
study whitelist at creation, so no settings change touches something already running.

### 5.9 Points summary

`PointsSummary`: `balance` (can be negative, «números rojos»), `xp` (only goes up), `level`,
`levelFloorXp`, `nextLevelXp`, `streakDays`, `bestStreakDays`, and `today` (`day`,
`focusMinutes`, `goalMinutes`, `goalMet`). Computed by `summarizeLedger` (§6).

---

## 6. Points and the ledger

All values: `points.ts`. The guardian derives each event's balance/XP delta with the Go
port of `applyLedgerInput` **at emission** and records it in the envelope (`points`, `xp`).
Recorded deltas are authoritative for history, so tuning a value later (bumping
`RULES_VERSION`) never rewrites past balances. `replayEvents` rebuilds everything else and
reports events whose derivation differs from the recorded delta (expected only across rule
versions).

### 6.1 Values

| Rule                               | Value                                                                                  | Constant                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Block completed                    | +1 per credited minute (manual and schedule only)                                      | `blockPointsPerMinute`, `earningBlockKinds`      |
| Study focus                        | +2 per accepted focused minute, +1 XP                                                  | `studyPointsPerFocusMinute`, `xpPerFocusMinute`  |
| Clean session bonus                | +20: block with 0 counted attempts, or study completed with 0 strikes and 0 attempts   | `cleanSessionBonus`                              |
| Clean bonus minimum (anti-farming) | ≥ 25 credited block minutes / planned study minutes                                    | `cleanSessionMinMinutes`                         |
| Attempt                            | 10 × 2^index, capped at 80 (−10, −20, −40, −80, −80…)                                  | `attemptBasePenalty`, `…Multiplier`, `…Cap`      |
| Escalation                         | index + 1 if the previous **counted** attempt (any target) was < 5 min earlier, else 0 | `attemptEscalationWindowMs`                      |
| Dedupe                             | same target key < 30 s after the previous detection (sliding) = same attempt           | `attemptDedupeWindowMs`                          |
| Strike                             | −15                                                                                    | `strikePenalty`                                  |
| Punishment starts                  | −100                                                                                   | `punishmentPenalty`                              |
| Emergency confirmed                | −max(200, floor(max(0, balance) / 2)) and the streak                                   | `emergencyMinPenalty`, `emergencyBalanceDivisor` |
| Emergency countdown                | 10 min normal, 30 min strict, 5 min confirm window                                     | `EMERGENCY_RULES`                                |
| Level curve                        | level L starts at 30 × L × (L − 1) XP (L2 = 60, L3 = 180, L7 = 1260)                   | `levelXpStep`                                    |
| Daily goal                         | 60 focused minutes (15–600)                                                            | `dailyGoalDefaultMinutes`                        |
| Reward shop                        | `REWARD_OFFERS` (e.g. `youtube-15`: 15 min for 150)                                    | `REWARD_OFFERS`                                  |
| Allowance refund on revocation     | floor(cost × remaining / total)                                                        | `allowanceRefund`                                |

PROMPT-literal defaults: XP, focus minutes, the daily goal and the streak come **only** from
Study Mode focused minutes; blocks earn points only. There are no daily caps. Ending a study
session early is neither penalized nor rewarded. The only anti-farming rules beyond PROMPT
are the clean-bonus minimum (25 min) and how block minutes are credited (§10.9: awake time
only, each real minute credited to one block at most, not while an allowance opens part of
the block). All three are recorded as decisions (§17).

### 6.2 Ledger state and inputs

`LedgerState` (persisted in `state.json`, rebuildable from the log): `balance`, `xp`,
`streak` (closed streak up to `lastClosedDay`), `bestStreak`, `lastClosedDay`, `openDays`
(focus minutes of days not yet closed), `voidedDay`, `escalation` (`lastCountedAtMs`,
`index`) and `dedupe` (last detection time per target key, pruned to the window).

`applyLedgerInput(state, input)` is pure; `ledgerInputFromEvent` maps logged events to inputs:

| Input                 | From event                           | Delta                                                                |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `attempt_detected`    | (not logged: every raw detection)    | merged (0) or counted (−penalty); see §10.8                          |
| `attempt`             | `attempt`                            | −penalty at the derived escalation index (0 if `penalized` is false) |
| `block_completed`     | `block_completed`                    | `blockCompletionPoints(kind, creditedMinutes, attemptsCounted)`      |
| `block_reactivated`   | `block_reactivated`                  | −`revertPoints`                                                      |
| `focus_minutes`       | `focus_minutes`                      | +2/min, +1 XP/min; adds to `openDays[day]` if that day is still open |
| `strike`              | `strike`                             | −15                                                                  |
| `study_ended`         | `study_ended`                        | +20 if `studyEndBonus(...)`                                          |
| `punishment_started`  | `punishment_started`                 | −100                                                                 |
| `emergency_confirmed` | `emergency_confirmed`                | −`emergencyPenalty(balance)`; streak → 0; today voided               |
| `reward_redeemed`     | `reward_redeemed`                    | −cost                                                                |
| `reward_ended`        | `reward_ended`                       | +`allowanceRefund` when revoked, 0 when expired                      |
| `day_closed`          | `day_closed`                         | 0; updates the streak                                                |
| `balance_correction`  | `tamper_detected`, `ledger_repaired` | `balanceCorrection` (≤ 0)                                            |
| `epoch_started`       | `epoch_started`                      | resets the ledger; balance = min(0, carry); escalation carried       |

### 6.3 Streak

- `day_closed{day, goalMinutes}` is emitted for each local day that ends while the guardian
  runs (and, at startup, for the last open day if it already ended). `goalMinutes` is the
  goal in force that day.
- On `day_closed(D)`: a day already closed is ignored; `met = focus(D) ≥ goal ∧ D ≠
voidedDay`; `streak = met ? (D = lastClosedDay + 1 ? streak + 1 : 1) : 0`. Days missing
  from the log (machine off) break the streak through the consecutive-day check.
- Displayed `streakDays` on day `today` = the closed streak if `lastClosedDay ≥ today − 1`,
  plus 1 if today's goal is already met and today is not voided.
- An emergency unlock sets the streak to 0 and voids the current day (it cannot count even if
  the goal is met later that day). `streakDaysLost` is the displayed streak just before.

### 6.4 Parity vectors

`points-vectors.json` holds `functions` (single calls such as `emergencyPenalty(402) = 201`)
and `sequences` (inputs with per-step expected deltas and outcomes, then an expected
`summarizeLedger`). The expectations are written by hand from the rules, never generated
from either implementation. Vitest runs them in `points.test.ts`; the Go port must run the
same file in place (`go test` reads `../../../packages/shared/test/fixtures/points-vectors.json`
relative to its package) following the `$comment` instructions. Coverage: escalation,
reset at exactly 5 min, cap, sliding dedupe, cross-layer dedupe, negative balance, both
emergency branches and rounding, clean bonuses and their minimum, study bonus conditions,
streak growth, break, gap, goal snapshot, duplicate close, voided day, XP and levels,
refunds, reactivation, epochs, penalties off, replayed attempts, tamper corrections.

---

## 7. Event log

### 7.1 Envelope

One JSON object per line (`EventEnvelopeBase` plus `type` and `data`). Field order on disk:
`v, epoch, seq, at, wallOffsetMs, day, type, points, xp, txEnd, req, data, prevMac, mac`.

| Field            | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `v`              | Envelope version, `1`. Changes are additive (new types, new optional data fields)    |
| `epoch`, `seq`   | `seq` starts at 1 in each epoch, no gaps                                             |
| `at`             | Trusted time (UTC, millisecond precision, `Z`)                                       |
| `wallOffsetMs`   | `W` at emission; display time of the event is `at + wallOffsetMs`                    |
| `day`            | Local day at emission                                                                |
| `points`, `xp`   | Recorded deltas (§6). `xp ≥ 0`. For `epoch_started`, `points` is the carried balance |
| `txEnd`          | `true` on the last event of its batch                                                |
| `req`            | Hex fingerprint of the idempotency key that caused it (§8.6), or `null`              |
| `prevMac`, `mac` | HMAC chain (§11.4). Never served by the API                                          |

Readers must tolerate unknown `type`s: store them raw, apply their recorded `points`/`xp`,
keep advancing the cursor (`UnknownGuardianEvent`, `isKnownEvent`).

### 7.2 Event types

Δ is the recorded balance delta.

| Type                                     | Emitted when                                                        | `data`                                                                                                                           | Δ                  |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `epoch_started`                          | First event of every epoch (install, data deletion, unreadable log) | `reason`, `previousEpoch`, `carryOverBalance` (≤ 0), `escalation`, `kept` (`EpochKeptState`)                                     | carry              |
| `guardian_started`                       | Every start, after recovery                                         | `version`, `schemaVersion`, `catalogVersion`, `rulesVersion`, `mode`, `sameBoot`, `downtimeMs`, `uncleanShutdown`, `recovery`    | 0                  |
| `clock_jump`                             | Detector reported a jump, restore jump, reboot clamp or calibration | `source` (`tick`/`restore`/`reboot`/`calibrate`), `deltaMs`, `wallOffsetMs`, `trust`, `reactivatedBlockIds`                      | 0                  |
| `day_closed`                             | A local day ended                                                   | `day`, `goalMinutes`                                                                                                             | 0                  |
| `block_created`                          | User block, schedule occurrence, punishment                         | `block` (snapshot), `source` (`user`/`schedule`/`punishment`)                                                                    | 0                  |
| `block_extended`                         | `POST …/extend`                                                     | `blockId`, `addMinutes`, `endsAt` (trusted)                                                                                      | 0                  |
| `block_completed`                        | `T ≥ endsAt` (after the boot hold, §10.2)                           | `blockId`, `kind`, `mode`, `creditedMinutes`, `attemptsCounted`, `downtimeMs`, `clockTrust`                                      | minutes + bonus    |
| `block_cancelled`                        | Emergency confirmed                                                 | `blockId`, `emergencyId`, `forfeitedMinutes`                                                                                     | 0                  |
| `block_reactivated`                      | Calibration showed a completion happened early                      | `blockId`, `revertsSeq`, `revertPoints`, `endsAt`, `reason: clock_correction`                                                    | −revertPoints      |
| `attempt`                                | A detection counted (§10.8)                                         | `attemptId`, `layer`, `targetKey`, `targetType`, `serviceId`, `blockIds`, `browser`, `incognito`, `escalationIndex`, `penalized` | −penalty           |
| `process_closed`                         | A blocked process was closed without counting an attempt            | `reason` (`running_at_block_start`/`logon_grace`/`browser_without_extension`), `serviceId`, `appId`, `browser`, `blockIds`       | 0                  |
| `study_started`                          | `POST /v1/study/sessions`                                           | `session`                                                                                                                        | 0                  |
| `study_paused`                           | Pause                                                               | `sessionId`, `pauseEndsAt`                                                                                                       | 0                  |
| `study_resumed`                          | Resume or 5-min auto-resume                                         | `sessionId`, `auto`                                                                                                              | 0                  |
| `focus_minutes`                          | ≥ 5 accepted whole minutes pending, at the end, at local midnight   | `sessionId`, `minutes`                                                                                                           | +2/min (XP +1/min) |
| `strike`                                 | Counted strike                                                      | `sessionId`, `strikeNumber`, `cause`                                                                                             | −15                |
| `study_ended`                            | Completion, early end, abandonment, punishment                      | `sessionId`, `outcome`, `plannedMinutes`, `activeMinutes`, `focusedMinutes`, `strikes`, `attempts`                               | bonus              |
| `study_outcome`                          | «¿Lo has conseguido?» answered                                      | `sessionId`, `achieved`                                                                                                          | 0                  |
| `punishment_started`                     | Third strike or abandonment                                         | `punishment`                                                                                                                     | −100               |
| `punishment_ended`                       | Its block completed or was cancelled by an emergency                | `punishmentId`, `blockId`, `outcome` (`completed`/`emergency`)                                                                   | 0                  |
| `emergency_requested`                    | `POST /v1/emergency`                                                | `emergency`                                                                                                                      | 0                  |
| `emergency_cancelled`                    | User, expiry, all blocks ended, reboot                              | `emergencyId`, `reason`                                                                                                          | 0                  |
| `emergency_confirmed`                    | Confirmed while ready                                               | `emergencyId`, `blockIds`, `balanceBefore`, `penalty`, `streakDaysLost`, `goalMinutes`                                           | −penalty           |
| `reward_redeemed`                        | Redemption                                                          | `allowanceId`, `offerId`, `serviceId`, `minutes`, `cost`, `endsAt`, `extendedExisting`                                           | −cost              |
| `reward_ended`                           | Expiry or revocation                                                | `allowanceId`, `serviceId`, `reason`, `revokedByBlockId`, `cost`, `totalMs`, `remainingMs`, `refund`                             | +refund            |
| `schedule_created` / `schedule_updated`  | Schedule writes                                                     | `schedule`                                                                                                                       | 0                  |
| `schedule_deleted`                       | Schedule delete                                                     | `scheduleId`                                                                                                                     | 0                  |
| `settings_changed`                       | Settings write or a pending change becoming effective               | `settings` (effective), `pending`                                                                                                | 0                  |
| `extension_paired` / `extension_revoked` | Pairing                                                             | `extensionId`, `browser`, `boundOrigin` / `extensionId`                                                                          | 0                  |
| `tamper_detected`                        | Hosts edited/locked/path moved, bad state MAC, rollback             | `kind`, `balanceCorrection` (≤ 0; only `ledger_rollback` is non-zero by default)                                                 | correction         |
| `ledger_repaired`                        | A complete line failed MAC verification                             | `droppedFromSeq`, `droppedCount`, `archivedAs`, `balanceCorrection`                                                              | correction         |

Multi-event batches (`txEnd` only on the last line; «…» = zero or more, «[…]» = only when
pending):

- third strike: `strike`, [`focus_minutes`], `study_ended{punished}`, `block_created`,
  `punishment_started`, `reward_ended{revoked}`…
- abandonment: [`focus_minutes`], `study_ended{abandoned}`, `block_created`,
  `punishment_started`, `reward_ended{revoked}`…
- emergency confirm: `emergency_confirmed`, `block_cancelled`…, `punishment_ended{emergency}`…
- hardcore or exam block (user or schedule): `block_created`, `reward_ended{revoked}`…
- punishment block completion: `block_completed`, `punishment_ended{completed}`
- calibration correction: `block_reactivated`…, `clock_jump{calibrate}`

**Privacy.** The log is local. It contains reasons, tasks and custom domains because the app
needs them for statistics; guardian logs (`logs/`) never contain domains, reasons or tasks,
and `/v1/diagnostics` contains none of them.

---

## 8. HTTP API

Types, paths, limits, errors and validators: `guardian-api.ts`. Base URL
`http://127.0.0.1:47600` (`guardianBaseUrl()`), prefix `/v1`.

### 8.1 Conventions

- JSON, UTF-8. Requests with a body need `Content-Type: application/json` (415 otherwise),
  at most 64 KiB (413). GET/DELETE have no body.
- Unknown request fields: 400 `unknown_field`. Malformed JSON: 400 `invalid_json`. Semantic
  failures: 422 with `details: { path, issue }` (`ValidationIssue`, same paths as the TS
  validators). Duplicate JSON keys: 400 `invalid_json` (the guardian uses a strict tokenizer).
- Responses: absent values are `null`, lists `[]`, integers only, display timestamps.
  Clients validate responses in open mode (unknown fields ignored).
- Errors: `{"error": {"code", "message", "details"}}` (`GuardianErrorBody`); statuses in
  `GUARDIAN_ERROR_STATUS`. `message` is English for developers; the UI maps `code` to
  Spanish copy.
- `Cache-Control: no-store` on every response.

### 8.2 Authentication and scopes

| Auth         | Token                                            | Used by                                    |
| ------------ | ------------------------------------------------ | ------------------------------------------ |
| `none`       | —                                                | `GET /v1/health`, `POST /v1/pairing/claim` |
| `app`        | `Authorization: Bearer cta_…` from `client.json` | Electron main process                      |
| `ext`        | `Authorization: Bearer cte_…` from pairing       | Extension background                       |
| `app_or_ext` | either, with scope rules                         | `POST /v1/attempts`                        |

Missing or unknown token: 401 `unauthorized` (`WWW-Authenticate: Bearer`). Wrong scope: 403
`insufficient_scope`. Tokens are compared as SHA-256 digests in constant time.

### 8.3 Request pipeline (in order)

1. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` → else 403
   `host_not_allowed` (anti DNS rebinding).
2. `Origin` (if present) must be an allowed extension origin (§9.4) → else 403
   `origin_not_allowed`. App-token requests must carry **no** `Origin`.
3. Route and method → 404 `not_found` / 405 `method_not_allowed` (`Allow` header).
4. Auth and scope (§8.2); bound-origin check for extension tokens.
5. Rate limit → 429 `rate_limited` with `Retry-After` (§9.6).
6. Mode: in `frozen` or `safe` mode every write returns 503 `read_only` with
   `details.reason` (`schema_too_new` / `safe_mode`); reads keep working.
7. Body: media type, size, JSON, strict shape, semantics.
8. Idempotency lookup (§8.6), then the mutation (§11.3 commit order), then the response.

### 8.4 Versioning

`/v1` evolves additively. Clients ignore unknown response fields; the guardian rejects unknown
request fields, so clients gate optional new request fields on `health.capabilities`. New
enum values are breaking unless gated by a capability. A breaking change becomes `/v2`,
served next to `/v1` for at least one minor release. The app compares `health.apiVersion`
and `version` with what it bundles and offers «Actualizar el guardián».

### 8.5 Conditional and long-poll requests

- `GET /v1/state`: `ETag: "s-<stateVersion>"`; `If-None-Match` → 304 with no body.
  `stateVersion` increases on any change visible in the payload (per-tick counters
  included only at whole-minute granularity).
- `GET /v1/ext/rules`: `ETag: "r-<rulesVersion>"`; `waitVersion=<n>&waitMs≤25000` returns as
  soon as `rulesVersion ≠ n`.
- `GET /v1/events?waitMs≤25000`: returns as soon as an event with `seq > after` exists.
- At most 4 concurrent long polls per token (429 beyond).

### 8.6 Idempotency

Endpoints marked **I** accept `Idempotency-Key` (1–128 characters `[A-Za-z0-9_.:-]`; the
client generates a UUID per user intention and reuses it on retries). The guardian stores
`(scope, endpointId, key) → (sha256(body), status, response)` for 10 min:

- same key and same body → the stored response, `Idempotent-Replayed: true`;
- same key, different body → 409 `idempotency_conflict`.

Every event of the batch carries `req = hex(sha256(scope | endpointId | key))[:32]`. After a
restart the cache is rebuilt from the events of the last 10 min; a replay then returns the
**current** representation of the resource the original request created or changed (e.g.
`{block, stateVersion}`), again with `Idempotent-Replayed: true`. Without a key, a repeated
request is a new intention (another extension, another charge).

### 8.7 Endpoint summary

`GUARDIAN_ENDPOINTS` (38 entries; `testClock` only in `testhooks` builds):

| #   | Method | Path                                | Auth       | I   | Purpose                                    |
| --- | ------ | ----------------------------------- | ---------- | --- | ------------------------------------------ |
| 1   | GET    | `/v1/health`                        | none       |     | Liveness, versions, capabilities, problems |
| 2   | GET    | `/v1/state`                         | app        |     | Aggregated state (2 s poll, ETag)          |
| 3   | GET    | `/v1/diagnostics`                   | app        |     | «Copiar diagnóstico»                       |
| 4   | POST   | `/v1/blocks`                        | app        | I   | Create a block                             |
| 5   | GET    | `/v1/blocks`                        | app        |     | List active or recently ended blocks       |
| 6   | GET    | `/v1/blocks/{id}`                   | app        |     | One block with progress                    |
| 7   | POST   | `/v1/blocks/{id}/extend`            | app        | I   | Extend (never shorten)                     |
| 8   | GET    | `/v1/schedules`                     | app        |     | List schedules                             |
| 9   | POST   | `/v1/schedules`                     | app        | I   | Create a schedule                          |
| 10  | PUT    | `/v1/schedules/{id}`                | app        |     | Replace a schedule (guards)                |
| 11  | DELETE | `/v1/schedules/{id}`                | app        |     | Delete a schedule (guards)                 |
| 12  | POST   | `/v1/study/sessions`                | app        | I   | Start Study Mode                           |
| 13  | GET    | `/v1/study/sessions/current`        | app        |     | Current session or `null`                  |
| 14  | POST   | `/v1/study/sessions/{id}/heartbeat` | app        |     | Heartbeat + focused minutes                |
| 15  | POST   | `/v1/study/sessions/{id}/strike`    | app        | I   | Report a strike                            |
| 16  | POST   | `/v1/study/sessions/{id}/pause`     | app        |     | Pause (2 per hour, 5 min)                  |
| 17  | POST   | `/v1/study/sessions/{id}/resume`    | app        |     | Resume                                     |
| 18  | POST   | `/v1/study/sessions/{id}/end`       | app        | I   | End (guardian decides the outcome)         |
| 19  | POST   | `/v1/study/sessions/{id}/outcome`   | app        |     | «¿Lo has conseguido?»                      |
| 20  | POST   | `/v1/attempts`                      | app or ext |     | Report an attempt                          |
| 21  | GET    | `/v1/points`                        | app        |     | Points summary                             |
| 22  | GET    | `/v1/events`                        | app        |     | Event log sync (cursor, long poll)         |
| 23  | GET    | `/v1/emergency/preview`             | app        |     | What an emergency would cost               |
| 24  | POST   | `/v1/emergency`                     | app        | I   | Request an emergency unlock                |
| 25  | POST   | `/v1/emergency/{id}/cancel`         | app        |     | Cancel it (free)                           |
| 26  | POST   | `/v1/emergency/{id}/confirm`        | app        | I   | Confirm it when ready                      |
| 27  | GET    | `/v1/rewards`                       | app        |     | Shop                                       |
| 28  | POST   | `/v1/rewards/redeem`                | app        | I   | Redeem an offer                            |
| 29  | GET    | `/v1/settings`                      | app        |     | Effective settings + pending changes       |
| 30  | PUT    | `/v1/settings`                      | app        |     | Replace settings (weakening delayed)       |
| 31  | POST   | `/v1/pairing/code`                  | app        |     | New 6-digit pairing code                   |
| 32  | POST   | `/v1/pairing/claim`                 | none       |     | Extension claims a token                   |
| 33  | GET    | `/v1/pairing/extensions`            | app        |     | Paired extensions                          |
| 34  | DELETE | `/v1/pairing/extensions/{id}`       | app        |     | Revoke an extension                        |
| 35  | GET    | `/v1/ext/rules`                     | ext        |     | Signed blocking rules (ETag, long poll)    |
| 36  | POST   | `/v1/ext/heartbeat`                 | ext        |     | Extension heartbeat                        |
| 37  | POST   | `/v1/data/delete`                   | app        | I   | «Borrar todos mis datos»                   |
| 38  | POST   | `/v1/_test/clock`                   | app        |     | Test builds only: drive the fake clock     |

### 8.8 Endpoint reference

Request and response shapes are the TypeScript interfaces named here; examples abbreviate.

#### `GET /v1/health` → `HealthResponse`

```json
{
  "ok": true,
  "name": "centrate-guardian",
  "version": "0.1.0",
  "apiVersion": 1,
  "capabilities": [
    "blocks",
    "schedules",
    "study",
    "attempts",
    "emergency",
    "rewards",
    "settings",
    "pairing",
    "ext_rules_signed",
    "events_longpoll",
    "data_delete"
  ],
  "schemaVersion": 1,
  "catalogVersion": 1,
  "rulesVersion": 1,
  "startedAt": "2026-09-27T08:00:03.120Z",
  "serverNow": "2026-09-27T16:42:01.123Z",
  "mode": "normal",
  "problems": []
}
```

`problems`: codes only (`GUARDIAN_PROBLEMS`: `hosts_write_failed`, `hosts_contested`,
`hosts_unwritable`, `hosts_locked`, `hosts_path_overridden`, `process_watcher_failed`,
`schema_too_new`, `safe_mode`, `ledger_repaired`, `rollback_detected`, `disk_full`,
`clock_unverified`). No personal data. Web pages cannot read it (Origin rule).

#### `GET /v1/state` → `GuardianStateResponse` (or 304)

The single call behind the 2 s poll and the tray tooltip. Fields: `stateVersion`,
`serverNow`, `epoch`, `lastEventSeq`, `guardian` (`version`, `apiVersion`, `mode`,
`problems`), `clock` (`wallOffsetMs`, `trust`, `lastJump`, `lastCalibratedAt`),
`protection` (hosts status/entries, process watcher, paired extensions with `connected`,
`incognitoAllowed`, `hostPermission`, `appliedRulesVersion`; `browsersWithoutExtension`),
`blocks` (active, `endsAt` descending: `blocks[0]` drives the big countdown), `punishments`
(active), `nuclearActive`, `study`, `emergency` (`counting`/`ready` only), `allowances`
(active), `rewardsLock`, `nextSchedule` («Próximo horario: 16:00»), `points`,
`pendingSettings`, `recent.endedBlocks` (ended in the last 2 min, for «Hecho. +80 puntos»).

| UI surface              | Call                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Window visible          | `getState({etag})` every 2 s                                                                                   |
| Window hidden (tray)    | `getEvents({waitMs: 25000})` for notifications; `getState` on each new event and once a minute for the tooltip |
| Countdown               | `Date.parse(blocks[0].endsAt) - Date.now()` with one `setTimeout` aligned to the second                        |
| After resume from sleep | `getState()` immediately                                                                                       |

#### `GET /v1/diagnostics` → `DiagnosticsResponse`

Versions, OS, service manager, pid, port, uptime, mode; state integrity and sizes; clock
(offset, trust, clock source names, jumps in 24 h, last calibration); hosts (path, whether
the Windows `DataBasePath` override is in effect, status, entries, last write/verify,
tamper count, last DNS flush); process watcher stats; paired extensions; catalog and rules
versions; error counters. No domains, reasons, tasks or usernames.

#### `POST /v1/blocks` (I) — `CreateBlockRequest` → 201 `CreateBlockResponse`

```json
{
  "targets": {
    "serviceIds": ["youtube", "instagram"],
    "categoryIds": [],
    "appIds": [],
    "customDomains": ["example.org"],
    "customProcesses": []
  },
  "whitelistOnly": false,
  "allow": { "customDomains": [], "customProcesses": [] },
  "mode": "strict",
  "durationMinutes": 60,
  "endsAt": null,
  "reason": "Quiero aprobar mates",
  "acknowledgeLong": false,
  "acknowledgeNoEmergency": false
}
```

Validation (in order): shape (`createBlockRequestSchema`: exactly one of
`durationMinutes`/`endsAt`; exam ⇒ `whitelistOnly`; whitelist ⇒ no targets; otherwise ≥ 1
target and empty `allow`; category ids outside the closed set fail here with issue `enum`);
service or app ids the embedded catalog does not know → 422 `unknown_id`
(`details: {path, id}`; never silently dropped, so catalog skew is visible); protected
custom domain/process → 422 `protected_target`; distraction in `allow` → 422
`allow_distraction` (`details: {path, serviceId}`); duration: minutes =
`ceil((trustedEnds − T) / 60 000)` must be 5…1440 → 422 `duration_out_of_range`
(`details: {minMinutes, maxMinutes}`); acknowledgements → 422 `confirmation_required`
(`details.needs`: `["long"]`, `["no_emergency"]` or both). A client can never create a
punishment or recovered block (there is no `kind` field).

Effects: batch `block_created` (+ `reward_ended{revoked}` for each active allowance when the
mode is hardcore or exam); `stateVersion`++, `rulesVersion`++, enforcement re-rendered.
Response: `{ block, stateVersion }`. Nothing appears active in the UI until this 201.

#### `GET /v1/blocks?status=active|ended&before=&limit=` → `ListBlocksResponse`

`active` (default): all active blocks, `endsAt` descending. `ended`: blocks that ended in the
last 7 days, `endedAt` descending, `before` cursor, `limit` 1–100 (default 50); older history
lives in the app's database. Bad query → 400 `bad_query`.

#### `GET /v1/blocks/{id}` → `GetBlockResponse`

`{ block, progress: { creditedMinutes, downtimeMs } }` (progress is excluded from `/state` to
keep its ETag stable). Unknown id → 404.

#### `POST /v1/blocks/{id}/extend` (I) — `{ "addMinutes": 30 }` → `ExtendBlockResponse`

`addMinutes` 1–1440; there is no zero, negative or «set» variant. Errors: 404; 409
`block_not_active` (`details.status`; the UI shows «El bloqueo ya terminó»); 409
`not_extendable` (punishment blocks); 422 `extension_exceeds_max` when the new remaining
time would exceed 24 h (`details.maxAddMinutes`). Hardcore extensions need no
acknowledgement. Effects: `block_extended`, versions++, hosts `until` header updated.

**Undo contract.** The app keeps «+30 min · Deshacer (5 s)» locally and only sends the
request after 5 s with a fresh idempotency key; once the guardian has an extension it is
final, so undo can never shorten a real block.

#### Schedules

`GET /v1/schedules` → `{ schedules }`. `POST /v1/schedules` (I) with `ScheduleInput` → 201
`{ schedule }`. `PUT /v1/schedules/{id}` with `ScheduleInput` (full replace) → 200
`{ schedule }`. `DELETE /v1/schedules/{id}` → 204.

`ScheduleInput`: `name` (1–60), `enabled`, `days` (unique 1–7), `start`, `end` (different;
window ≥ 5 min; overnight allowed), `timezone` (IANA loadable by the embedded tzdata, not
`"Local"` → 422 `invalid_timezone`), `targets`, `whitelistOnly`, `allow`, `mode`, `reason`,
`acknowledgeNoEmergency` (required for hardcore/exam). Limit 50 schedules (422
`validation_failed`, issue `length`).

Guards for PUT and DELETE, evaluated in trusted time (§10.3):

- the schedule has an occurrence in progress → 409 `schedule_in_progress`
  (`details: {blockId, endsAt}`): no edit and no delete until that block ends («sin tocar uno
  que ya esté en curso»);
- the next occurrence starts within 10 min and the edit is **weakening**, or it is a
  delete → 409 `schedule_starting_soon` (`details.startsAt`). Strengthening edits (enable,
  add targets or days, stricter mode, longer window) are always allowed.

A materialized occurrence is an independent block and never changes with its schedule.

#### Study Mode

- `POST /v1/study/sessions` (I) — `StartStudyRequest` (`task` ≤ 80, `plannedMinutes` 5–480,
  `pomodoro` or `null`, `camera`) → 201 `{ session }`. 409 `study_already_active`. Allowed
  during punishments and exam blocks. Snapshots `settings.punishment` into `policy`.
- `GET /v1/study/sessions/current` → `{ session | null }`.
- `POST …/{id}/heartbeat` — `HeartbeatRequest` (`seq` strictly increasing, `state`,
  `focusScore` 0–100 or `null`, `focusedMsSinceLast` 0–600 000, `cameraOn`) →
  `HeartbeatResponse` (`duplicate`, `acceptedFocusMs`, `session`, `serverNow`,
  `heartbeatDeadlineMs`). Sent every 15 s by the **Electron main process only**, and at
  once after resume; the main process stops sending when the hidden analysis loop has been
  dead for > 60 s, so killing the camera window counts as abandonment. A `seq` ≤ the last one
  is a no-op with `duplicate: true`. This is the only «report focused minutes» operation.
  409 `study_not_active` when the session already ended.
- `POST …/{id}/strike` (I) — `{ "cause": "doubt_timeout" | "no_face" | "phone" |
"distraction_app" }` → `StrikeResponse` (`counted`, `reason` `cooldown` /
  `not_in_work_phase` / `null`, `strikeNumber`, `pointsDelta`, `cooldownUntil`, `punishment`,
  `session`). The third counted strike returns the `Punishment` and `session.status:
"punished"`.
- `POST …/{id}/pause` `{}` → `{ session }`; 409 `already_paused`, 409 `pause_quota_exhausted`
  (`details.nextPauseAt`). `POST …/{id}/resume` `{}` → `{ session }`; 409 `not_paused`. The
  guardian auto-resumes after 5 min.
- `POST …/{id}/end` (I) — `{ "reason": "user" }` → `EndStudyResponse` (`session`, `summary`:
  `outcome`, `activeMinutes`, `focusedMinutes`, `focusPct`, `strikes`, `attempts`,
  `pointsTotal`, `cleanBonus`). The guardian decides the outcome: `completed` if ≤ 30 s of
  planned active time remained, otherwise `ended_early` (no penalty, no bonus). It never
  trusts a client «completed».
- `POST …/{id}/outcome` — `{ "achieved": "yes" | "partial" | "no" }` → `{ session }`. Once,
  within 24 h of the end: 409 `outcome_already_set`, 409 `outcome_window_closed`; 404 for
  sessions older than 7 days.

#### `POST /v1/attempts` — `AttemptRequest` → `AttemptResponse`

```json
{
  "layer": "extension",
  "target": { "type": "domain", "value": "www.youtube.com" },
  "browser": "chrome",
  "incognito": false
}
```

Scope rules: the ext token may only send `layer: "extension"` with a `domain` (hostname only;
the URL never leaves the browser); the app token may only send `layer: "window"` with a
catalog `service` id matched from window titles. `process` is guardian-internal. Anything
else → 403 `insufficient_scope`.

```json
{
  "blocked": true,
  "counted": true,
  "merged": false,
  "attemptId": "att_…",
  "pointsDelta": -20,
  "episodePointsDelta": -20,
  "escalationIndex": 1,
  "nextPenalty": 40,
  "serviceId": "youtube",
  "block": {
    "id": "blk_…",
    "kind": "manual",
    "mode": "strict",
    "endsAt": "…",
    "reason": "Quiero aprobar mates"
  },
  "reason": null
}
```

A merged detection returns `counted: false, merged: true, pointsDelta: 0` and the
`attemptId`/`episodePointsDelta` of the attempt it merged into, so `blocked.html` can still
show «−20 puntos» for a reload. A target that is not blocked returns `blocked: false` with
`reason` `not_blocked` or `allowance_active`.

#### `GET /v1/points` → `{ points: PointsSummary }`

#### `GET /v1/events?epoch=&after=&limit=&waitMs=` → `EventsResponse`

`after` default 0; `limit` 1–1000 (default 500); `waitMs` 0–25 000. If `epoch` is omitted or
differs from the current one, the response has `reset: true` and starts at the beginning of
the current epoch. Response `{ epoch, reset, events, lastSeq, hasMore }`; events without
`prevMac`/`mac`. The app stores `(epoch, lastSeq)` in the same `node:sqlite` transaction as the
inserted events (exactly-once, crash-safe). On `reset: true` it wipes derived tables and
resyncs.

#### Emergency

- `GET /v1/emergency/preview?blockIds=blk_a,blk_b` → `EmergencyPreviewResponse`
  (`eligible`, `reason` `hardcore`/`exam`/`no_active_blocks`/`emergency_in_progress`/`null`,
  `blockIds`, `excludedBlockIds` (hardcore/exam blocks that stay), `countdownMinutes`,
  `penaltyPoints`, `balance`, `streakDays`, `phrase`). Without `blockIds`: every eligible
  active block. Powers «Perderás 620 puntos y tu racha de 5 días».
- `POST /v1/emergency` (I) — `{ blockIds, phrase, language }` → 201 `{ emergency }`
  (`counting`). Errors: 422 `phrase_mismatch` (`emergencyPhraseMatches`), 409
  `emergency_in_progress`, 409 `emergency_not_available` (`details: {reason, blockIds}`:
  a listed block is hardcore/exam, not active or unknown).
- `POST /v1/emergency/{id}/cancel` `{}` → `{ emergency }` (`cancelled`, reason `user`). Free,
  allowed while `counting` or `ready`; 409 `emergency_expired` otherwise.
- `POST /v1/emergency/{id}/confirm` (I) — `{ "acknowledge": true }` →
  `ConfirmEmergencyResponse` (`emergency`, `penaltyApplied`, `balanceAfter`,
  `cancelledBlockIds`, `streakDaysLost`). Errors: 409 `emergency_not_ready`
  (`details.readyAt`), 409 `emergency_expired` (the 5-min window passed), 409
  `emergency_moot` (every listed block already ended; the emergency is cancelled free).

#### Rewards

- `GET /v1/rewards` → `RewardsResponse` (`locked`, `lockReason` `hardcore`/`exam`/
  `punishment`/`study`, `balance`, `offers` (every `REWARD_OFFERS` item with `affordable`,
  `shortBy`, `available`, `unavailableReason` `not_blocked`/`insufficient_points`/`locked`),
  active `allowances`). The UI turns `shortBy` into «Te faltan 40 puntos».
- `POST /v1/rewards/redeem` (I) — `{ "offerId": "youtube-15" }` → 201 `RedeemRewardResponse`
  (`allowance`, `pointsDelta`, `balanceAfter`). Errors: 422 `unknown_offer`, 409
  `rewards_locked` (`details.reason`), 409 `service_not_blocked`, 409 `insufficient_points`
  (`details: {balance, cost, shortBy}`). Custom domains can never be redeemed.

#### Settings

`GET /v1/settings` → `{ settings, pending }`. `PUT /v1/settings` with the full
`GuardianSettings` → `{ settings, pending }` after applying §5.8. Errors: 422
`validation_failed`, 422 `invalid_timezone`, 422 `protected_target` (whitelist extras).
Writes `settings_changed`.

#### Pairing

- `POST /v1/pairing/code` `{}` → 201 `{ code, expiresAt, port }`. A new code invalidates the
  previous one. The app shows it at 32 px (with «Puerto: N» if not 47600).
- `POST /v1/pairing/claim` (no token; `Origin` absent or an allowed extension origin) —
  `{ code, browser, browserVersion, extVersion }` → 201 `{ extensionId, token,
guardianVersion, boundOrigin }`. Errors: 401 `pairing_code_invalid`, 410
  `pairing_code_expired`, 409 `pairing_no_code`, 429.
- `GET /v1/pairing/extensions` → `{ extensions }`. `DELETE /v1/pairing/extensions/{id}` → 204
  (`extension_revoked`; its long polls are closed).

#### `GET /v1/ext/rules` → `ExtRulesResponse` (signed; ETag; long poll)

```json
{
  "rulesVersion": 57,
  "serverNow": "…",
  "blockDomains": ["youtube.com", "www.youtube.com", "instagram.com", "example.org"],
  "excludedDomains": ["accounts.youtube.com"],
  "whitelist": null,
  "blocks": [
    {
      "id": "blk_…",
      "kind": "manual",
      "mode": "strict",
      "endsAt": "…",
      "reason": "Quiero aprobar mates",
      "serviceIds": ["youtube", "instagram"],
      "domains": ["youtube.com", "…"],
      "whitelistOnly": false
    }
  ],
  "allowances": [{ "serviceId": "tiktok", "endsAt": "…" }],
  "punishment": null,
  "nextChangeAt": "…",
  "penaltiesEnabled": true
}
```

- `blockDomains`: union of active blocks' resolved domains − allowance domains − whitelist
  allow set. `excludedDomains`: catalog `excludedSubdomains` and always-allowed hosts under
  them. `whitelist`: `null` or `{ allowDomains, allowHostPatterns }` (intersection across
  whitelist blocks, plus allowance domains and always-allowed hosts).
- `nextChangeAt`: earliest end among blocks and allowances; the extension sets an alarm.
- **Signature.** Every 200 carries `X-Centrate-Signature: v1=<base64url(HMAC-SHA256(key =
UTF-8 extension token, message = exact body bytes))>` (`verifyRulesSignature`). The
  extension ignores an unsigned or invalid body and keeps its cache, and only **shrinks** its
  rules on a validly signed response. When the guardian is unreachable it keeps each cached
  block until that block's cached `endsAt`.
- DNR mapping: `blockDomains` → `redirect` to `blocked.html` via `requestDomains` for
  `main_frame` and `sub_frame`, with `excludedRequestDomains` from `excludedDomains`;
  whitelist → lower-priority redirect for every `main_frame` plus higher-priority `allow`
  rules for `allowDomains`, `allowHostPatterns` (`regexFilter`), `127.0.0.1` and `localhost`.
  Sub-resources are never blocked in whitelist mode.

#### `POST /v1/ext/heartbeat` — `ExtHeartbeatRequest` → `{ rulesVersion, serverNow }`

Every 30 s (`chrome.alarms`) and after each rules sync: `extVersion`, `browser`,
`browserVersion`, `incognitoAllowed`, `hostPermission`, `appliedRulesVersion`.

#### `POST /v1/data/delete` (I) — `{ "confirm": "BORRAR" }` → `DeleteDataResponse`

Accepts `DATA_DELETE_CONFIRM_WORDS` (trimmed, case-insensitive) else 422
`confirm_word_mismatch`. 409 `data_delete_blocked` (`details.reason`: `study_active`,
`emergency_pending`). Response `{ epoch, carryOverBalance, keptBlockIds, keptPunishmentIds,
keptScheduleIds }`. Algorithm §10.11.

#### `POST /v1/_test/clock` — `TestClockRequest` → `{ serverNow, trustedNow }`

Compiled only with the `testhooks` build tag. Exactly one of `advanceMs`, `suspendMs`,
`jumpMs`, `reboot`. Drives the fake clock for Playwright end-to-end tests.

---

## 9. Security

### 9.1 Listener

Binds `127.0.0.1:<port>` only (never `0.0.0.0` or `::`). `ReadHeaderTimeout` 5 s,
`ReadTimeout` 10 s, `WriteTimeout` 30 s (long polls use `http.ResponseController` to extend
their own deadline), `MaxHeaderBytes` 16 KiB, at most 64 open connections.

### 9.2 App token

On **every** start the guardian generates 32 random bytes, writes
`cta_<base64url>` to `<sysdir>/client.json` atomically:

```json
{
  "v": 1,
  "port": 47600,
  "token": "cta_…",
  "guardianVersion": "0.1.0",
  "pid": 4312,
  "issuedAt": "…"
}
```

Readable by local users (Windows: SYSTEM and Administrators full, `BUILTIN\Users` read;
POSIX `0644 root`), writable only by admins. The Electron main process reads it at startup
and again after any 401 (`TokenSource` function), never exposes it to renderers, and sends
requests from Node's `fetch` (undici), which sends no `Origin` header. **App-token requests
carrying `Origin` are rejected** (403), so the token is useless from any browser context.
Node 22's global `fetch` was checked to send no `Origin` on GET and POST; the app must use it
(not Electron's `net.fetch`, whose behaviour still needs the spike in §17).

The token authenticates «a local non-browser client», not the human; it is not a secret
from local users by design. Anti-cheat rests on the API surface: holding the token gives
nothing a click in the UI would not.

### 9.3 Extension pairing

```text
App (main)                     Guardian                                  Extension (options/popup → background)
 POST /pairing/code ─────────▶ code = 6 digits from crypto/rand (rejection sampling),
                               TTL 300 s, single use, failures = 0, replaces older code
 ◀──── {code, expiresAt, port}
 shows «048392»                ◀─── POST /pairing/claim {code, browser, …}   Origin: chrome-extension://<id> | moz-extension://<uuid> | none
                               checks: code live; Origin allowed (§9.4); constant-time compare;
                               mismatch → failures++, 5 failures burn the code
                               token cte_… (32 random bytes); store {id, sha256, raw, boundOrigin, browser};
                               burn code; event extension_paired
                               ── 201 {extensionId, token, boundOrigin} ─────────────────▶ chrome.storage.local
```

Limits: 5 failures per code, 20 claims per 10 min globally; ≈ 5 × 10⁻⁶ success chance per
code for a blind guesser. If `boundOrigin` is set, every later request with that token that
carries an `Origin` must match it. The raw token is kept in the admin-only `secret/`
directory only to sign `/v1/ext/rules`.

### 9.4 CORS and Origin

Allowed origins: exactly `chrome-extension://<id>` for ids in the embedded
`CHROMIUM_EXTENSION_ID` (pinned by the manifest `key`; Chrome, Edge, Brave, Opera and
Vivaldi) plus admin-configured store ids in `config.json`, and any `moz-extension://<uuid>`
(Firefox assigns a random UUID per profile; the token and the bound origin are the real
gate). Any other `Origin` → 403 on every route, `/v1/health` included (no fingerprinting by
web pages).

Preflight `OPTIONS` from an allowed origin → 204 with:

```text
Access-Control-Allow-Origin: <exact origin>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key, If-None-Match
Access-Control-Expose-Headers: ETag, X-Centrate-Signature, Idempotent-Replayed, Retry-After
Access-Control-Max-Age: 600
Access-Control-Allow-Private-Network: true      (only when requested)
Vary: Origin
```

Otherwise 403 without CORS headers. `Access-Control-Allow-Credentials` is never sent (no
cookies). Writes require `application/json`, which forces a preflight for any cross-origin
caller.

### 9.5 Attempts from the extension

`blocked.html` is web-accessible, so any page could open it; it therefore **never reports
attempts**. The background service worker reports an attempt only when it observes a
`main_frame` navigation to a blocked host (`webNavigation.onBeforeNavigate`, checked against
the cached rules) and passes the response (`episodePointsDelta`, reason, `endsAt`) to the
page it redirected. Sub-frame embeds are blocked but never counted. (PROMPT §6 says
blocked.html reports; this deviation needs the `webNavigation` permission and a spike, §17.)

### 9.6 Rate limits

Token buckets: app token 50 req/s (burst 100); each extension token 10 req/s (burst 20) and
5 attempts/s; pairing claims 20 per 10 min globally; 4 concurrent long polls per token.
Excess → 429 `rate_limited` with `Retry-After`.

### 9.7 No command execution from data

Every external program runs from an absolute path with a constant argv; no request data ever
reaches a command line, a path or a registry key. Process kills use PIDs from the
guardian's own process listing (`TerminateProcess` / `SIGTERM` then `SIGKILL`), never
`taskkill /IM` or `killall <name>`. DNS flushing uses the existing `hosts.FlushDNS`
(`DnsFlushResolverCache` with fallback `%SystemRoot%\System32\ipconfig.exe /flushdns`;
`/usr/bin/dscacheutil -flushcache` + `/usr/bin/killall -HUP mDNSResponder`;
`resolvectl flush-caches` or `nscd -i hosts`).

---

## 10. Algorithms

### 10.1 Engine loop

One goroutine owns all mutable state; API handlers send commands to it and wait for the
result, so there are no data races and every mutation follows the commit order (§11.3).

```go
// Every TICK = 2 s, and immediately after API mutations, fsnotify events and resume.
func (e *Engine) Step() {
    j := e.clock.Tick()                       // existing Detector
    if j.Jumped() { e.emit(clockJump("tick", j)) ; e.bumpVersions() }
    T := e.clock.EffectiveNow()
    dAwake := clamp(awakeNow - e.lastAwake, 0, 10*time.Second)
    e.closeDays(T)                            // §6.3; flushes study focus first
    e.applyPendingSettings(T)                 // §5.8
    e.expireAllowances(T)                     // §10.7
    e.completeBlocks(T)                       // §10.9 (honours the boot hold)
    e.activateSchedules(T)                    // §10.3
    e.creditBlocks(dAwake, T)                 // §10.9
    e.studyStep(dAwake, T)                    // §10.4
    e.emergencyStep()                         // §10.6 (boot clock)
    e.nuclear.Reconcile()                     // §10.5
    if e.enforcementDirty { e.reconcileEnforcement() }  // §10.10
    e.persistIfDue()
}
```

The process watcher (every 1.5 s) and the hosts watcher run in their own goroutines and
send detections and change notices to the engine.

### 10.2 Clock: jumps, reboots, calibration, resurrection

- **Tick.** `Detector.Tick`; a non-zero `Delta` emits `clock_jump{source:"tick"}`, bumps
  `stateVersion` and `rulesVersion` (display times moved) and schedules a calibration in
  10 s.
- **Startup, same boot.** `Detector.Restore(snapshot)`; a jump made while stopped emits
  `clock_jump{source:"restore"}`. `Downtime` is added to each active block's `downtimeMs`.
- **Startup, new boot.** `Restore` picks the earlier candidate; `WallBehind` emits
  `clock_jump{source:"reboot"}`. `clockTrust` becomes `unverified`; a `counting`/`ready`
  emergency is cancelled (`reboot`, its countdown ran on the old boot clock); the study
  session gets the reboot grace (§10.4); calibration runs immediately.
- **Boot-id fallback.** When either boot id carries a fallback prefix (`derived:`,
  `boottime:`), sameness is decided by boot-clock continuity alone (`cur.Boot ≥ saved.Boot`).
  A wrong «same boot» makes `T` lag (blocks last longer), never shorter; trusting a changed
  `derived:` id would accept a clock change made while stopped as a reboot. (Change needed in
  `clock.SameBoot`, §17.)
- **Boot hold.** After a new boot with `serverTimeCheck` on, blocks and punishments whose
  trusted `endsAt` falls in `(savedT, T]` are not completed until the first calibration
  answers (success, disagreement or offline) or 120 s of boot time pass. They stay enforced
  meanwhile. Allowance expiry is never held.
- **Calibration.** When `settings.serverTimeCheck` is on: 60 s after boot or resume, 10 s
  after any jump, then every 30 min. Sources: IP-literal HTTPS first
  (`https://1.1.1.1/cdn-cgi/trace` `ts=`, `https://1.0.0.1/cdn-cgi/trace`,
  `https://8.8.8.8/` `Date`; certificates carry IP SANs, so neither DNS nor the hosts file can
  redirect them), then the existing hostname list. TLS uses
  `tls.Config{Time: trustedNow}` so a forward-jumped wall clock cannot break validation. At
  least 2 answers within 3 s of each other are required (median, RTT/2 corrected); otherwise
  trust is unchanged. `Detector.Calibrate(median)` then only moves `T` back. Success sets
  `trust = verified` for the rest of this boot.
- **Resurrection.** When a calibration moves `T` back, every block or punishment completed
  with `clockTrust != "verified"` since the last successful calibration (whatever the boot;
  the list is persisted, bounded to 200 entries) whose trusted `endsAt` is still after the
  corrected `T` is reactivated: `block_reactivated{revertPoints}` (its completion points are
  taken back) and the punishment returns to `active`. The event batch ends with
  `clock_jump{source:"calibrate", reactivatedBlockIds}`. The app notifies «La hora del
  sistema estaba adelantada: el bloqueo sigue hasta las 18:40».
- `clockTrust` stamped on completions: `verified` after a successful calibration in this
  boot, `disabled` when the setting is off (resurrection then impossible), else
  `unverified`.

### 10.3 Schedules

```go
func (e *Engine) activateSchedules(T time.Time) {    // trusted time: clock changes cannot skip or repeat
    for _, s := range e.schedules {
        if !s.Enabled { continue }
        loc := tz(s.Timezone)                            // embedded tzdata
        for _, d := range []Date{localDate(T, loc).AddDays(-1), localDate(T, loc)} { // yesterday: overnight
            occ, ok := occurrence(s, d, loc)              // DST gap → first valid instant; overlap → earliest
            if !ok || T.Before(occ.Start) || !T.Before(occ.End) || e.materialized[occ.Key] { continue }
            e.materialized[occ.Key] = T                   // also when later cancelled: never re-created
            if occ.End.Sub(T) < time.Minute { continue }  // nothing meaningful left
            e.commit(blockCreated(scheduleBlock(s, T, occ), "schedule"), revokeIfStrong(...)...)
        }
    }
    prune(e.materialized, 8*24*time.Hour)
}
```

`occurrence.Key = scheduleId + "@" + localDate`. A window missed entirely while the machine
was off enforces nothing; a late activation enforces only the remaining time.
`nextOccurrence` is the earliest start after `T` within 8 days.

**Weakening edits** (refused within 10 min of the next start): disabling; removing any
target id or custom entry; removing days; changing the time zone; a window that does not
contain the old window for the next occurrence; a lower mode rank (`normal` < `strict` <
`hardcore` < `exam`); `whitelistOnly` true → false; adding `allow` entries. Renaming and
changing `reason` are neutral. Deleting counts as weakening.

### 10.4 Study Mode

**Phase** (guardian-computed): `paused` while a pause is open; without Pomodoro always
`work`; with Pomodoro `work` while `activeAwakeMs mod (work+break) < work`, else `break`.
`activeAwakeMs` grows with awake time outside pauses (breaks included); suspended time never
counts.

**Heartbeat acceptance.** Each tick adds the awake ms of `work` phases to
`unclaimedEligibleMs` (capped at 10 min). A heartbeat accepts
`min(focusedMsSinceLast, unclaimedEligibleMs)`, resets the counter, records
`lastSignalAwake` and flushes: when accepted whole minutes not yet logged reach
`focusFlushMinutes` (5), it emits `focus_minutes`. Remaining whole minutes are flushed at
the session end and at local midnight (so each minute lands on the right day).

**Abandonment.** Only awake time while the guardian was running counts:

- `lastSignalAwake` is set by every heartbeat; a guardian start in the **same boot** sets
  it to the start moment (a guardian crash or update never causes abandonment; the app
  simply resumes heartbeating); a start after a **reboot** gives `bootGraceMs` (10 min) for the
  app to reopen and resume the session.
- If `awakeNow − lastSignalAwake > heartbeatTimeoutMs` (120 s; 600 s during the reboot
  grace), the batch is: pending `focus_minutes`, `study_ended{abandoned}`, punishment
  (§10.5).
- Never after the planned end: once `activeAwakeMs ≥ plannedMinutes`, the session completes
  (`study_ended{completed}` + bonus if eligible), with or without heartbeats.

**Pauses.** At most `maxPausesPerWindow` (2) pauses may start within the last hour of awake
time (409 `pause_quota_exhausted` with `nextPauseAt`); each lasts at most 5 min and
auto-resumes (`study_resumed{auto:true}`). A pause is not allowed while already paused.

**End.** `POST …/end`: `completed` if planned active time − `activeAwakeMs` ≤ 30 s, else
`ended_early`. No penalty. The app's updater refuses to install during a session.

### 10.5 Strikes, punishments and Nuclear

```go
func (e *Engine) strike(s *Session, cause string) StrikeResponse {
    if phase(s) != "work" { return notCounted("not_in_work_phase") }       // breaks and pauses never strike
    if awakeNow-s.lastStrikeAwake < rules.Study.StrikeCooldownMs { return notCounted("cooldown") }
    s.Strikes++; s.lastStrikeAwake = awakeNow
    batch := []Event{strikeEvent(s, cause)}                                 // −15 from the ledger
    if s.Strikes >= rules.Study.MaxStrikes {                                // 3
        batch = append(batch, flushFocus(s), studyEnded(s, "punished"))
        batch = append(batch, e.punishmentEvents(s, "three_strikes")...)
    }
    e.commit(batch...)
}

func (e *Engine) punishmentEvents(s *Session, cause string) []Event {
    pol := s.Policy                                                         // snapshot from session start
    b := newBlock(kind: "punishment", mode: "strict", startsAt: T, endsAt: T + pol.Minutes)
    switch pol.Level {
    case "distractions", "nuclear": b.Targets.CategoryIDs = allCategoryIDs  // every web + app category
    case "whitelist": b.WhitelistOnly = true                                // study whitelist snapshot
    }
    p := newPunishment(b, s, cause, pol)                                    // stacks: never merged
    return append([]Event{blockCreated(b, "punishment"), punishmentStarted(p)}, e.revokeAllowances(b.ID)...)
}
```

`punishment_started` costs −100. When the punishment block completes, the batch is
`block_completed` (0 points) + `punishment_ended{completed}`.

**Nuclear supervisor** (while any active punishment has level `nuclear`, every 3 s): if the
app is not running in the active console session, relaunch it **as the console user**,
never as root/SYSTEM, from an admin-owned path, with the constant argument
`--centrate-nuclear`:

| OS      | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → `CreateProcessAsUserW` with `appPath` from the admin-only `config.json` (written by the installer under `Program Files`)                                                                                                                                                                                                                                  |
| macOS   | `launchctl kickstart gui/<consoleUid>/io.github.imdlodoem23.centrate.nuclear`: a LaunchAgent installed by the privileged installer in `/Library/LaunchAgents` (`LimitLoadToSessionType Aqua`, `ProgramArguments ["/usr/bin/open", "-b", "io.github.imdlodoem23.centrate", "--args", "--centrate-nuclear"]`). launchd runs it as the user; the guardian never executes anything from the user-writable app bundle |
| Linux   | Best effort: an XDG autostart entry plus the app's own supervisor (documented limitation)                                                                                                                                                                                                                                                                                                                        |

The app shows the overlay whenever `state.nuclearActive` is true; its only way out is the
emergency unlock (strict: 30 min + penalty).

### 10.6 Emergency unlock

```text
          request (phrase ok, all blocks active & normal/strict, none pending)
   none ─────────────────────────────────────────────────▶ COUNTING
                                                              │ bootNow ≥ readyAtBoot (boot clock: immune to clock changes)
   CANCELLED ◀── cancel(user) / reboot / all blocks ended ── READY ── confirm (≤ 5 min) ──▶ CONFIRMED
                                                              └── 5 min without confirm ──▶ EXPIRED
```

- Countdown: `emergencyCountdownMinutes(modes)`, measured on the **boot clock**
  (`readyAtBoot = bootNow + countdown`), which keeps counting during suspend; a reboot
  cancels (`reboot`). `readyAt` and `confirmBy` are reported as `now + (atBoot − bootNow)`
  in display time.
- Phrase: `emergencyPhraseMatches` (ASCII whitespace collapse, ASCII lowercase, one trailing
  `.` ignored). The guardian cannot tell typing from pasting; the UI enforces typing.
- Blocks created during the countdown are not included. Hardcore and exam blocks can never
  be listed and stay active.
- Confirm batch: `emergency_confirmed` (penalty computed from the balance **at confirm**,
  streak lost, day voided), `block_cancelled` for each listed block still active,
  `punishment_ended{emergency}` for punishment blocks. `emergency_moot` if none remain
  (cancelled free, `blocks_ended`).
- Data deletion is refused while an emergency is pending.

### 10.7 Rewards

```go
func (e *Engine) redeem(offerID string) (*Allowance, error) {
    o, ok := rules.Offer(offerID);                     if !ok { return nil, E422("unknown_offer") }
    if r := e.rewardsLock(); r != "" {                 return nil, E409("rewards_locked", r) } // hardcore|exam|punishment|study
    if !e.serviceCoveredByActiveBlock(o.ServiceID) {   return nil, E409("service_not_blocked") }
    if bal := e.ledger.Balance; bal < o.Cost {          return nil, E409("insufficient_points", bal, o.Cost) }
    a := e.activeAllowance(o.ServiceID)                // extend if one is active
    if a == nil { a = newAllowance(o, T) } else { a.EndsAt += o.Minutes; a.Minutes += o.Minutes; a.Cost += o.Cost }
    e.commit(rewardRedeemed(a, o))                      // −cost; rulesVersion++, hosts re-render
}
```

- Effect: the service's catalog domains leave the hosts set and `blockDomains`, join the
  whitelist allow set; its catalog processes are exempt from the watcher; attempts against
  it return `blocked: false, reason: "allowance_active"`.
- Expiry at `T ≥ endsAt`: `reward_ended{expired}`.
- When a hardcore/exam block or a punishment starts, every active allowance is revoked in
  the same batch: `reward_ended{revoked, revokedByBlockId}` with
  `refund = allowanceRefund(cost, endsAt − startedAt, endsAt − T)`.
- Normal/strict blocks created later do not cancel a paid allowance.

### 10.8 Attempts

**Target resolution** (guardian side, against active blocks and their stored resolution):

| Layer                | Covered when                                                                                                                                                     | Dedupe key                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| extension (`domain`) | the host equals or is under a resolved domain of a non-whitelist block (and is not an excluded host), or a whitelist block is active and the host is not allowed | `svc:<id>` if `findServiceByDomain` finds a catalog service, else `dom:<host without leading www.>`             |
| window (`service`)   | an active block targets that service (directly or through a category) or a whitelist block is active and the service is not allowed                              | `svc:<id>`                                                                                                      |
| process (internal)   | the executable matches a blocked process (identity-aware on Windows/macOS: OriginalFilename, bundle id)                                                          | `svc:<id>` if the app belongs to a service, else `app:<appId>`, else `proc:<name>` (lowercase on Windows/macOS) |

**Pipeline.** Not covered → `blocked: false`. Covered by an active allowance → `blocked:
false, reason: allowance_active`. Otherwise the detection goes through the ledger's
`attempt_detected` (the Go port): merged → no event (the dedupe window slides); counted →
an `attempt` event with the derived `escalationIndex`, `penalized = settings.attemptPenalties`
and the penalty as its recorded delta; every covering block's `attemptsCounted` and the
active study session's `attempts` increase. The guardian keeps the last counted attempt id
and delta per key in memory to answer merged detections (`episodePointsDelta`).

**Process watcher** (every 1.5 s): lists processes (Windows `CreateToolhelp32Snapshot` +
`QueryFullProcessImageNameW`; macOS `proc_pidpath`; Linux `/proc/<pid>/exe`), matches the
effective process set (blocks' resolved processes; in whitelist mode every catalog app
process except study apps and `allow`; minus allowance processes and protected processes),
kills matches in interactive sessions only (never PID ≤ 4, itself or its ancestors). Grace
without points: a process already running when the block started (first 60 s) and a process
started within 90 s of the user's logon emit `process_closed` instead of an attempt.

**Browsers without the extension.** `browsersWithoutExtension` lists browser families
running for > 60 s without a connected extension of that family (heartbeat within 90 s).
With `closeBrowsersWithoutExtension` on and a block active, those browsers are closed by PID
(`process_closed{browser_without_extension}`). Requires the catalog `BROWSERS` list (§17).

### 10.9 Block crediting and completion

- **Crediting.** Each tick, `dAwake` (awake ms, clamped 0–10 s; suspended and guardian-down
  time are never credited) goes to exactly **one** block: the earliest-ending active
  `manual`/`schedule` block, excluding blocks that target a service with an active
  allowance (ties: earliest created). Overlapping blocks therefore never earn the same
  minute twice, and each still reaches its own clean-bonus minimum if it gets enough
  exclusive time.
- **Completion.** At `T ≥ endsAt` (subject to the boot hold): `status = completed`,
  `endedAt = endsAt` (the scheduled end, not the detection time), `block_completed` with
  `creditedMinutes = floor(creditedMs / 60 000)`, `attemptsCounted`, `downtimeMs`,
  `clockTrust`; points from `blockCompletionPoints`. A block whose end passed while the
  guardian was off completes on the first tick after start with the credit it actually saw.
  The completion is remembered for resurrection (§10.2).

### 10.10 Enforcement rendering

```go
func (e *Engine) desiredDomains() []string {
    D := set()
    wl := activeWhitelistBlocks()
    for _, b := range activeBlocks() { D.add(b.Resolved.Domains...) }
    if len(wl) > 0 { D.add(catalog.AllDistractionDomains()...) }   // hosts cannot say "everything except"
    D.remove(whitelistAllowSet(wl)...)                              // intersection across whitelist blocks
    for _, a := range activeAllowances() { D.remove(catalog.Domains(a.ServiceID)...) }
    D.remove(catalog.AlwaysAllowedHosts...); D.remove(excludedDomains()...); D.removeProtected()
    return D.sortedCapped(20_000)                                    // log (without domains) if capped
}
```

**Hosts section** (existing `hosts.Manager`: markers, byte-for-byte preservation of user
lines, EOL/BOM handling, atomic replace with ACL/owner/SELinux copy, retries, in-place
fallback after a successful backup, watcher, `FlushDNS`), extended with one header line so
enforcement survives total state loss:

```text
# >>> CENTRATE START
# Managed by Céntrate. Do not edit: changes are restored.
# centrate-hosts v1 until=2026-09-27T17:42:00Z count=68
0.0.0.0 youtube.com
:: youtube.com
…
# <<< CENTRATE END
```

`until` is the latest trusted `endsAt` among active blocks; `count` the number of domains.
An empty desired set removes the section.

**Reconcile** runs when enforcement is dirty, on watcher notices (debounced 500 ms), every
30 s and after resume:

- Windows hosts path: `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\DataBasePath`
  (environment variables expanded) + `\hosts`, re-read every 60 s. If it differs from the
  default the guardian follows it, reports `hosts_path_overridden` and emits
  `tamper_detected{hosts_path_overridden}` once while blocks are active.
- Section altered or removed while blocks are active → re-applied within ~1 s and
  `tamper_detected{hosts}` at most once a minute (`balanceCorrection: 0`: antivirus false
  positives).
- Locked file (read-only attribute, `chattr +i`, `chflags uchg/schg`, ACL deny): Windows
  clears the read-only attribute for the write and restores it; other locks → status
  `locked`/`unwritable` and `tamper_detected{hosts_locked}`; the extension layer keeps
  enforcing.
- ≥ 5 rewrites in 60 s → status `contested`, retry every 10 s, logged once.
- Backups: `backups/hosts.original` (first file seen, section stripped, never overwritten,
  restored on uninstall if the file is unusable) plus the existing rotating `hosts.bak`.

**Extension rules**: `rulesVersion`++ on every enforcement change; waiting long polls return.

### 10.11 Data deletion

One batch, refused during a study session or a pending emergency:

1. `carry = min(0, balance)`; escalation state kept.
2. Kept: active blocks, active punishments, active allowances, schedules in progress or
   within the 10-min pre-start freeze, **settings and pending settings unchanged** (no
   instant weakening), paired extensions.
3. Deleted: every event segment of the old epoch, ended blocks and sessions, other
   schedules, the idempotency cache, guardian logs.
4. New epoch with `epoch_started{reason:"data_deleted", previousEpoch, carryOverBalance,
escalation, kept}`; the anchor (§11.4) moves to the new epoch.

The new epoch is rebuildable from its own events (kept entities travel in `kept`, so nothing
is re-charged). PRIVACY.md must say that a negative balance survives deletion.

### 10.12 Startup and recovery ladder

The service manager's start callback returns at once; this runs in a goroutine (no Windows
SCM 30 s timeout risk):

1. Exclusive lock on `run/guardian.lock` (`LockFileEx`/`flock`) or exit.
2. `ensureDirs` (§11.1): reject and recreate symlinks/junctions at the data dir, reset owner
   and protected DACL/modes. Remove stale `*.tmp-*` files here and in the hosts directory.
3. Unclean start if `run/clean-shutdown` is missing; ≥ 3 unclean starts within 5 min →
   **safe mode**.
4. Load `state.json` (MAC-verified) → else `state.prev.json` → else rebuild from the log.
   Newer `schemaVersion` → **frozen mode** (§11.5).
5. Verify the log chain (§11.4); truncate a torn final line; move a trailing batch without
   `txEnd` to `quarantine/`; replay `seq > state.lastEventSeq` through the same reducer as the
   live path (in safe mode, stop at the first bad event and keep the rest unapplied).
6. Compare with the rollback anchor → `tamper_detected{ledger_rollback}` with
   `balanceCorrection = min(0, anchor.balance − balance)`.
7. Clock restore (§10.2): jump, reboot handling, study grace, emergency cancel, boot hold.
8. `guardian_started{…, recovery}`; `day_closed` catch-up.
9. **Reconcile enforcement before opening the API.**
10. Rotate `client.json`, bind the listener, start loops.

If both state files and the log are unusable: parse the hosts section header; if `until` is
in the future, start a new epoch (`log_unreadable`) whose `kept.blocks` holds one
**recovered** block (kind `recovered`, mode **strict** so the emergency exit still exists,
`customDomains` = the section's domains, `endsAt = until`, earns nothing); otherwise start
empty and remove the section. The hosts file is never left broken: if it is unparseable,
restore `hosts.original`.

---

## 11. Storage

### 11.1 System directory layout

`<sys>` = `C:\ProgramData\Centrate\`, `/Library/Application Support/Centrate/`,
`/var/lib/centrate/` (overridable for tests with `CENTRATE_DATA_DIR`; hosts path with
`CENTRATE_HOSTS_PATH`, existing `platform` package).

```text
<sys>/                            admin rw, users r+x
  config.json                     installer-written, admin-only: {schemaVersion, port, appPath, extraExtensionIds[], logLevel}
  client.json                     {v, port, token, guardianVersion, pid, issuedAt} (rotated each start), users r
  state.json, state.prev.json     snapshot + previous generation, users r
  events/current                  current epoch id
  events/<epoch>/00000001.jsonl   append-only segments named by first seq; roll at 8 MiB; MAC chain spans segments
  quarantine/                     torn tails, partial batches, corrupt snapshots, bad events
  backups/hosts.original          pristine hosts (section stripped), never overwritten
  backups/hosts.bak(.1,.2)        existing rotating copies before our writes
  backups/state.v<N>.json         pre-migration snapshots (last 3)
  secret/                         SYSTEM + Administrators only / root 0700
    ledger.key                    32 random bytes: HMAC key for events and state
    extensions.json               [{id, sha256, raw, boundOrigin, browser, pairedAt}]
  run/                            guardian.lock, clean-shutdown, starts.json, clock.json (Detector snapshot)
  logs/guardian.log(.1…5)         5 MiB rotation; never domains, reasons or tasks
Rollback anchor (second location, removed on uninstall), content {epoch, seq, mac, balance, xp, at}:
  Windows  HKLM\SOFTWARE\Centrate\Guardian, value "Anchor" (REG_SZ JSON)
  macOS    /Library/Preferences/io.github.imdlodoem23.centrate.guardian.plist
  Linux    /etc/centrate/anchor.json (0600)
```

`ensureDirs` on every start: Windows owner Administrators (existing `platform.EnsureDir`) and
protected DACL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)`, `secret\` with
`D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`; POSIX `root:root` (`root:wheel`), directories 0755,
files 0644, `secret/` 0700 with 0600 files. Any user can pre-create `ProgramData\Centrate`,
so ownership is always reset.

### 11.2 Atomic writes

`writeAtomic(path, bytes)` for state, `client.json`, backups and the anchor file:

1. Create `<name>.tmp-<pid>-<rand>` **in the same directory** with `O_CREATE|O_EXCL` and the
   target's mode/owner (Windows: the target's security descriptor).
2. Write, `fsync` (`FlushFileBuffers`; macOS `F_FULLFSYNC`), close.
3. `state.json` only: keep the previous generation (POSIX `link` + `rename` to
   `state.prev.json`; Windows `ReplaceFileW(…, REPLACEFILE_WRITE_THROUGH)` does both).
4. Rename over the target (`rename(2)` / `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)`, retried
   up to 10 times on sharing violations), then `fsync` the directory on POSIX.

Hosts writes use the existing `hosts.Manager` procedure (§10.10).

### 11.3 Commit order

For every mutation:

1. validate; 2. build the batch (deltas from the Go ledger port; `txEnd` on the last line);
2. append all lines with **one** `write` on an `O_APPEND` handle, then `fsync`;
3. apply to memory; 5. reconcile enforcement (rules version bump immediately; hosts write
   with a 1 s budget, retries continue in the background and show in `protection.hosts`);
4. respond; 7. `state.json` debounced (≤ 1 s after mutations, every 30 s for tick counters,
   always at clean shutdown); 8. update the anchor with the state write.

The log is the write-ahead log: a crash after step 3 is replayed at start. A final line
without `\n` was never acknowledged and is truncated. A trailing batch without its `txEnd`
line (a write torn at a line boundary) is moved to `quarantine/` as a whole, so a crash can
never leave, for example, an emergency penalty applied without its block cancellations.

### 11.4 Integrity

- Each line's `mac = base64url(HMAC-SHA256(ledger.key, B))`, where `B` is the line's JSON
  serialized up to and including `prevMac` (the `mac` field is appended last);
  `prevMac` equals the previous line's `mac` (`""` for the first line of an epoch).
- A complete line that fails verification: keep the valid prefix, move the rest to
  `quarantine/corrupt-<ts>.jsonl`, rebuild, append `ledger_repaired{droppedFromSeq,
droppedCount, archivedAs, balanceCorrection = min(0, anchor.balance − rebuiltBalance)}`.
  Editing any line loses every gain after it.
- `state.json` carries a `mac` over its body; a mismatch → rebuild from the log and
  `tamper_detected{state_mac}`.
- The anchor lives outside `<sys>`; restoring an old copy of the whole folder is caught by
  `tamper_detected{ledger_rollback}` with a downward correction.
- Honest limit: an administrator who reads `secret/ledger.key` and writes a program can
  forge a consistent chain. This raises the bar from «Notepad» to «reverse-engineer and
  code»; it is not DRM.

### 11.5 Schema versions and migrations

- `state.json`, `config.json`, `client.json`, `secret/extensions.json` carry an integer
  `schemaVersion` (1), bumped only for incompatible changes. Older → copy to
  `backups/state.v<N>.json`, apply `migrate_N_to_N+1` (pure `map[string]any` functions with
  golden-file tests), write atomically.
- Newer (downgrade) → **frozen mode**: never write `state.json`, enforce from the frozen
  `enforcement` core (below) and the hosts `until` header until each item ends, then remove
  the section; writes return 503 `read_only{schema_too_new}`; `mode: "frozen"`; the app says
  «Reinstala la última versión».
- The `enforcement` core of `state.json` is **frozen forever at v1** so any guardian version
  can enforce and expire blocks from it:
  `{"v":1,"clock":<Detector snapshot>,"items":[{"id","endsAtTrusted","domains","excludedDomains","processes","whitelist","allowDomains"}]}`.
- Events: envelope `v: 1`, additive only; old lines are never rewritten; a breaking change
  needs a new envelope version and readers for both.
- Catalog: `catalogVersion` (number) and ids are never deleted; rules: `rulesVersion`.

---

## 12. Generated-data pipeline

```text
packages/shared/src/catalog  ── catalogSnapshot() ──┐
packages/shared/src/points.ts ─ rulesSnapshot() ────┼─▶ scripts/gen-guardian-data.mjs ─▶ guardian/internal/embedded/
packages/shared/src/guardian-api.ts ─ apiContractSnapshot() ┘   (esbuild bundle in memory)       catalog.json, rules.json, api.json
```

- The generator bundles a tiny entry with esbuild (already a workspace dev dependency),
  imports it and writes each file as
  `{"generatedBy": "scripts/gen-guardian-data.mjs", "sourceSha256": "…", "data": {…}}` with
  sorted keys and a trailing newline. Never edit these files by hand.
- The guardian embeds them with `//go:embed`, decodes them at init with
  `DisallowUnknownFields` into typed structs and refuses to start on a mismatch (a unit
  test decodes them too). Every numeric rule in the Go code (points, penalties, countdowns,
  windows, limits, error statuses, default settings) comes from these structs, never from
  literals.
- CI: `node scripts/gen-guardian-data.mjs && git diff --exit-code guardian/internal/embedded`.
- Parity: `go test ./internal/points` runs `packages/shared/test/fixtures/points-vectors.json`
  in place. API drift: golden request/response pairs in
  `packages/shared/test/fixtures/api/<endpoint>.<case>.json`, type-checked by vitest and
  decoded by Go with `DisallowUnknownFields`, re-encoded and compared.

---

## 13. Service lifecycle and CLI

Existing CLI (`guardian/cmd/centrate-guardian`): `run`, `install`, `uninstall [--keep-data]`,
`start`, `stop`, `restart`, `status` (JSON), `has-active`, `cleanup-hosts`, `version`. Fixed
arguments only; installers never pass user data.

- `has-active` reads `state.json`'s enforcement core (works with the service stopped) and
  exits **0** (nothing active), **10** (a normal/strict block active), **11** (a hardcore,
  exam or punishment block active) or **1** (error). NSIS `customUnInit`, the `.deb`
  `prerm` (only for `remove`/`purge`) and the macOS/AppImage uninstall use it to warn «se
  perderán los puntos y la racha» (NSIS must also treat 11 as active, §17).
- Windows: service `CentrateGuardian`, LocalSystem, automatic start; recovery actions restart
  after 5 s, 10 s, 30 s (reset after 1 day) with `SetRecoveryActionsOnNonCrashFailures`;
  `install` is idempotent (`UpdateConfig`). `customInit` stops the old service with a timeout
  before files are replaced; `customUnInstall` does nothing on `${isUpdated}`. Stopping the
  service **never** removes the hosts section.
- macOS: binary in `/Library/PrivilegedHelperTools/`, LaunchDaemon plist (`RunAtLoad`,
  `KeepAlive`, `ThrottleInterval 5`) that never points into the user-writable app bundle,
  plus the Nuclear LaunchAgent (§10.5). The app compares `health.version` with its bundled
  guardian at launch and reinstalls an older one.
- Linux: unit with `Restart=always`, `RestartSec=2`, `StartLimitIntervalSec=0`,
  `NoNewPrivileges=yes`, without `ProtectSystem=strict` (the guardian writes `/etc/hosts`).
- Clean shutdown: stop the API (2 s grace), save state and `run/clock.json`, touch
  `run/clean-shutdown`, release the lock.
- Uninstall (`uninstall`, not an update): stop, strip the hosts section, flush DNS, delete
  `<sys>`, the anchor, the LaunchAgent and the service registration. Never blocked.

---

## 14. Client usage (`createGuardianClient`)

```ts
import { createGuardianClient, guardianBaseUrl } from '@centrate/shared/guardian-api';

// Electron main process: the token is re-read after a 401 (rotated on every guardian start).
const guardian = createGuardianClient({
  baseUrl: guardianBaseUrl(port),
  token: () => readClientJson().token,
  fetch: globalThis.fetch, // undici: no Origin header
});
const r = await guardian.getState({ etag });
if (!r.notModified) render(r.state);

// Extension background: paired token; signature checked before rules are applied.
const ext = createGuardianClient({ token: pairedToken });
const rules = await ext.getExtRules({ etag, waitVersion, waitMs: 25_000 });
```

Every response is validated before it is returned; failures throw `GuardianApiError` with
`status` (0 without a response) and `code` (a guardian code, or `unreachable`, `timeout`,
`invalid_response`, `invalid_signature`). Writes marked I send a fresh `Idempotency-Key`
unless the caller passes one (reuse it when retrying the same user intention). Default
timeout 3 s («si no responde en 3 s»), long polls add their `waitMs`.

---

## 15. Testability

- The engine depends only on interfaces with fakes: `Clock` (`FakeClock.Advance`,
  `Suspend` (wall + boot move, awake does not), `JumpWall`, `Reboot` (new boot id, clocks
  reset), `ServiceRestart`), hosts file system (temp dir; `CENTRATE_HOSTS_PATH`), DNS
  flusher, process lister/killer, network time, Nuclear relauncher.
- `Engine.Step()` runs exactly one tick: deterministic tests for every algorithm in §10.
- `testhooks` build tag: `POST /v1/_test/clock` for Playwright end-to-end runs against the
  real guardian binary.
- Route-table test: the router's routes equal `api.json` endpoints, and no `/v1/blocks`
  route ends, shortens, edits or deletes (mirrors the vitest test).
- Crash injection at every step of `writeAtomic` and the commit; torn-tail truncation at
  every byte of the last line and at every line boundary of a batch; `kill -9` during write
  bursts, then check: the hosts section is old or new, never mixed; `balance == Σ points`;
  no `seq` gaps.
- Fuzzing: hosts parser, domain normalizer, JSON decoders.
- Real-service CI jobs (runners have admin/sudo): install, create a YouTube block through the
  API, assert the hosts section (Windows: `Resolve-DnsName youtube.com` → `0.0.0.0`), restart
  and assert the block survives, advance the fake clock and assert removal, `uninstall`
  leaves the hosts file byte-identical to `hosts.original` and `<sys>` gone.
- Shared contract tests (this package): `points.test.ts` (vectors + rules),
  `guardian-api.test.ts` (validators, route table, client with a fake `fetch`, signatures).

---

## 16. Threat model

### 16.1 Assets, adversaries, boundaries

- **Assets:** active commitments (blocks, schedules, punishments), the points ledger and
  streak, the user's privacy (reasons, tasks, domains, camera never leaves the app).
- **Adversaries:** (a) the user themselves in a weak moment, as a normal user; (b) the same
  user with administrator rights; (c) web pages and remote hosts; (d) other extensions and
  local programs; (e) other local accounts on a shared PC.
- **Boundaries:** admin/root (guardian, system dir) vs the user session (app, extension);
  loopback HTTP; the browser sandbox.

### 16.2 Cheat matrix

| #   | Attack                                                                | Result                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Close or kill the app                                                 | The guardian keeps enforcing; during Study Mode > 120 s of awake silence → abandoned → punishment (−100)                                                                                    |
| 2   | Kill the guardian                                                     | Service manager restarts it in ≤ 5 s; hosts entries persist; no credit for downtime; no study punishment for the guardian's own downtime                                                    |
| 3   | Stop/disable the service (admin)                                      | Hosts entries stay; the extension keeps cached rules until each `endsAt`; the app shows «Guardián detenido». Residual: admin                                                                |
| 4   | Edit the hosts section                                                | Re-applied in ~1 s; `tamper_detected{hosts}`                                                                                                                                                |
| 5   | Lock the hosts file / move it via `DataBasePath`                      | Attribute cleared or followed; `tamper_detected`; extension unaffected                                                                                                                      |
| 6   | Change the clock while the guardian runs                              | `W` absorbs it; real remaining time unchanged; display `endsAt` moves                                                                                                                       |
| 7   | Stop the guardian, change the clock, restart (same boot)              | `Restore` measures the true gap with the boot clock; with a `derived:` boot id, continuity decides                                                                                          |
| 8   | Move the clock forward in BIOS/another OS, reboot                     | Boot hold + calibration catch it online; blocks completed early are resurrected and their points reverted. Residual while offline or with `serverTimeCheck` off (turning it off waits 24 h) |
| 9   | `curl` to end, shorten or edit a block, or to edit points             | No such route (404); negative `addMinutes` → 422                                                                                                                                            |
| 10  | Replay a create, extend or redeem                                     | Same key → stored response; new key → a new intention (charges again)                                                                                                                       |
| 11  | Race the extend undo                                                  | Undo is client-side before sending; the guardian's extension is final                                                                                                                       |
| 12  | Forge focus minutes                                                   | Bounded by work-phase awake time since the last heartbeat. Residual: ≤ 2 points per real minute                                                                                             |
| 13  | Suppress strikes by patching the app                                  | Undetectable. Residual; there is no API to remove or refund strikes                                                                                                                         |
| 14  | End Study early to dodge the third strike                             | Allowed by PROMPT (no penalty, no bonus); strikes already charged stay                                                                                                                      |
| 15  | Abuse pauses                                                          | 2 per rolling hour, 5 min each, guardian-enforced                                                                                                                                           |
| 16  | Delete/disable a schedule just before it starts                       | Weakening edits frozen 10 min before; in-progress schedules immutable; materialized blocks independent                                                                                      |
| 17  | Lower the goal, penalties, punishment level, whitelist or time checks | Weakening waits 24 h; sessions and whitelist blocks use snapshots                                                                                                                           |
| 18  | Redeem during hardcore/exam/punishment/study, or a custom domain      | 409 `rewards_locked`; only catalog offers                                                                                                                                                   |
| 19  | Redeem, then start hardcore to keep YouTube                           | Allowance revoked with a pro-rata refund                                                                                                                                                    |
| 20  | Script the emergency phrase                                           | Countdown (boot clock) still applies; reboot cancels; 5-min confirm window; ≥ 200 points + streak                                                                                           |
| 21  | Delete data to escape a negative balance or pending penalties         | Negative balance and escalation carried; refused during study or a pending emergency; active items and settings kept                                                                        |
| 22  | Farm passive blocks (overlapping, asleep, many short ones)            | Awake-only credit, one block per real minute, clean bonus ≥ 25 min, punishments earn 0                                                                                                      |
| 23  | Edit `state.json` / the event log                                     | MAC fails → rebuild / truncate at the edit; later gains lost                                                                                                                                |
| 24  | Restore an old copy of the whole folder                               | Anchor mismatch → balance corrected down. Residual: restoring the anchor too (admin)                                                                                                        |
| 25  | Install an older guardian                                             | Frozen mode: enforces the v1 core until each end, never writes                                                                                                                              |
| 26  | Fake server on :47600 to empty the extension's rules                  | Unsigned rules are ignored. Residual: an admin who stops the guardian and reads the token from the browser profile                                                                          |
| 27  | Web page CSRF / DNS rebinding / fingerprinting                        | Host check, Origin allowlist on every route, JSON content type, token                                                                                                                       |
| 28  | A page opens `blocked.html` to forge attempts                         | The page never reports; only the background, on `main_frame` navigations                                                                                                                    |
| 29  | Another extension or local program calls the API                      | No token; origin not allowed; app token + Origin → 403. Residual: local programs can read `client.json` (by design, §9.2)                                                                   |
| 30  | Rename a blocked app's executable                                     | Identity match (OriginalFilename, bundle id). Residual: portable or unknown apps                                                                                                            |
| 31  | Another browser, incognito, portable browser, DoH, VPN, Tor           | Hosts still applies to the system resolver; the app warns; optional closing of browsers without the extension. Residual: remote-DNS proxies, Tor, VPNs                                      |
| 32  | Autostarting apps grief your points                                   | Logon and block-start grace: `process_closed`, 0 points                                                                                                                                     |
| 33  | Block critical targets (localhost, OS update/time hosts, Céntrate)    | Protected lists → 422 `protected_target`                                                                                                                                                    |
| 34  | Brute-force the pairing code                                          | 5 failures burn it; TTL 300 s; 20 claims per 10 min                                                                                                                                         |
| 35  | Uninstall                                                             | Allowed by design; warns that points and streak will be lost; leaves the system clean                                                                                                       |

### 16.3 Honest limits

On a computer you administer, no block is impossible to bypass: an administrator can stop
or uninstall the service, edit the hosts file while it is stopped, reverse-engineer the
ledger key, or boot another OS. The design makes every bypass deliberate, slow, visible in
the log and never cheaper than the emergency unlock. The camera AI and window-title layer
run in a user process and can be patched. On shared PCs the ledger is machine-wide and
`client.json` is readable by every local account (another account could start sessions or
report window attempts); v1 assumes one person per machine (future hardening: peer PID/exe
checks via `GetExtendedTcpTable` or `/proc/net/tcp`, or a named pipe with peer
credentials). The server time check contacts 1.1.1.1, 1.0.0.1 and 8.8.8.8 (HTTPS, no
identifiers) and must be disclosed in PRIVACY.md.

---

## 17. Follow-ups outside `packages/shared` (owners: coordinator and module agents)

1. **Catalog** (`packages/shared/src/catalog`): add `BROWSERS` (id, family, process names
   per OS) and `PROTECTED_DOMAINS` (OS update and time hosts such as `microsoft.com`,
   `windowsupdate.com`, `windows.com`, `apple.com`, `time.windows.com`, `pool.ntp.org`,
   `github.com`, `githubusercontent.com`, the website host, `localhost`), both in
   `catalogSnapshot()`. Keep `alwaysAllowedHosts`, `excludedSubdomains` and study
   `hostPatterns` in the snapshot (the rules endpoint serves them).
2. **Generator** `scripts/gen-guardian-data.mjs` and `guardian/internal/embedded` (§12), plus
   the CI freshness check; `npm run gen:guardian` script in the root `package.json`.
3. **Clock** (`guardian/internal/clock`): fallback boot-id rule in `SameBoot` (§10.2);
   `NetworkTime` with IP-literal sources first, ≥ 2 agreeing answers and
   `tls.Config{Time: trustedNow}`.
4. **Hosts** (`guardian/internal/hosts`): the `# centrate-hosts v1 until=… count=…` header
   line and its parser; Windows `DataBasePath` resolution; `hosts.original`.
5. **CLI and installers**: `has-active` exit code 11 and the NSIS check for 10 **or** 11;
   Nuclear LaunchAgent in the macOS installer; `appPath` in `config.json`.
6. **Extension**: `webNavigation` permission and background-only attempt reporting (§9.5).
7. **Spikes**: Electron 44's main-process global `fetch` sends no `Origin`, as Node 22's does
   (§9.2); Chromium and Firefox
   extension fetches' `Origin` behaviour and Private Network Access; `webNavigation` fires for
   the original URL before the DNR redirect; Windows Defender and hosts edits; suspend clock
   semantics on real hardware (S3, S4, Modern Standby, Fast Startup).
8. **DECISIONS.md entries** (Spanish, one line each): XP/streak only from Study focus; awake-
   only, one-block-per-minute block credit and no credit while an allowance opens the block;
   clean-bonus minimum 25 min; global attempt escalation; sliding 30 s dedupe; punishments
   stack; emergency allowed on punishments (strict) and one emergency covers several blocks;
   reboot cancels a pending emergency; 10-min freeze for weakening schedule edits and
   in-progress schedules immutable; 24 h delay for weakening settings; rewards locked during
   Study Mode; allowances revoked with pro-rata refund; negative balance, escalation and
   settings survive data deletion; attempts reported by the extension background instead of
   `blocked.html`; app-token requests without `Origin`; ending Study early is free; 10-min
   reboot grace for Study Mode; recovered blocks are strict and earn nothing; `has-active`
   exit codes; no port fallback; Go 1.26.
