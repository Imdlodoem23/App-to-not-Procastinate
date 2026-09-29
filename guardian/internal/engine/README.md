# guardian/internal/engine

The guardian's core (docs/ARCHITECTURE.md §10): one goroutine owns every entity and the
points ledger, runs the time-driven step every 2 s and before every command, commits
mutations in contract order and renders enforcement. The API layer calls the exported
command methods; each one runs in a single engine turn.

## How a command runs

```text
API handler ──▶ e.CreateBlock(ctx, Request, body)
                  └─ run(e, ctx, cmdOpts{write, idem, status}, fn)      engine.go
                       exec: on the loop goroutine (after Start) or inline, serialized
                       ├─ timeStep()                  §10.1: clock, days, pending settings,
                       │                              allowances, credit, completion,
                       │                              schedules, daily limits, study,
                       │                              emergency
                       ├─ writable()                  frozen/safe → 503 read_only
                       ├─ idemLookup()                replay (*ReplayedResponse) / 409
                       ├─ fn(): validate → batch → commit
                       │     commit = AppendBatch (fsync) → applyEvent (reducers)
                       │              → reconcile (hosts, DNS, matcher, extRulesVersion)
                       │              → anchor (sync when needed)
                       ├─ idemStore()                 stored response (EncodeResponse)
                       └─ afterTurn()                 reconcile if due, tamper events,
                                                      state.json when due (urgent after
                                                      a commit, else every 30 s)
```

Queries that may wait (`Events`, and `GetExtRules` in extrules.go) read the store or wait
on a notifier **outside** the engine goroutine, so a long poll never blocks the engine.

Every state change goes through `applyEvent` (reduce.go), both live and when the startup
ladder replays the log after the last `state.json` (§10.12 step 6). Reducers never emit
events and never touch enforcement.

## File ownership

| File | Owner | Contents |
| --- | --- | --- |
| `doc.go`, `README.md` | core | package documentation |
| `engine.go` | core | `Engine`, `Options`, `New`/`Open`/`Start`/`Stop`/`Shutdown`, loop, `exec`/`run` dispatcher, `Step`, `timeStep`, `commit` |
| `deps.go`, `fakes.go`, `fakeclock.go` | core | dependency interfaces (`Clock`, `HostsManager`, `HostsSectionHeader`, `DNSFlusher`, `NetworkTime`, `NuclearRelauncher`, process lister/killer, `Ticker`) and their fakes (`FakeClock`, `FakeHosts`, `FakeHeaderHosts`, `FakeDNS`, `FakeNetworkTime`, `FakeRelauncher`, `FakeProcesses`) |
| `types.go` | core | wire mirrors of `domain.ts` and the core API types of `guardian-api.ts` |
| `events.go` | core | event type names, the data struct of **every** event type, the `batch` builder |
| `state.go`, `persist.go` | core | persisted `engineState`, enforcement core, `state.json`, anchor, idempotency |
| `reduce.go` | core | `applyEvent` (dispatches to every reducer) and the core reducers |
| `clock.go` | core | tick jumps, calibration, correction, resurrection, boot hold (§4, §10.2) |
| `blocks.go`, `validate.go` | core | blocks: create, extend, list, get, credit, complete, punishment and cancellation helpers, request validation |
| `enforce.go`, `frozen.go` | core | enforcement rendering and reconcile, hosts writes and DNS flushes on workers (1 s turn budget), hosts tamper, problems, frozen mode |
| `procdetect.go` | core | process watcher detections → `process_closed` / attempts |
| `days.go` | core | `day_closed` and the points summary |
| `startup.go`, `restore.go` | core | the startup and recovery ladder; the clock restore (newest sealed snapshot by log position, stops that cannot be measured) and the stopped-service check |
| `queries.go`, `hasactive.go`, `testclock.go`, `util.go`, `errors.go` | core | health, state, diagnostics, points, events; `HasActive` for the CLI; the test clock; helpers; `APIError` |
| `study.go` (+ `study_test.go`) | Study Mode | §5.4, §10.4, §10.5, Nuclear supervisor, nuclear heartbeat |
| `emergency.go` (+ test) | emergency | §5.6, §10.6 |
| `rewards.go` (+ test) | rewards | §5.7, §10.7 |
| `schedules.go` (+ test) | schedules | §5.3, §10.3 |
| `limits.go`, `limitrules.go` (+ `limits_test.go`, `limits_vectors_test.go`) | daily limits | §5.10, §10.13: entity, usage reports and their clamps, day rollover, limit blocks until local midnight, 24 h pending changes; `limitrules.go` is the Go port of the pure rules, run against `limits-vectors.json` |
| `settings.go` (+ test) | settings | §5.8, the OS time zone (`detectOSZone`) |
| `datadelete.go` (+ test) | data deletion | §10.11 |
| `attempts.go` (+ test) | attempts | §10.8 |
| `pairing.go` (+ test) | pairing | §9.3, extension heartbeats and status |
| `extrules.go` (+ test) | extension rules | §8.8 signed rules, long poll |

Feature owners edit **only their files**. Each feature file already contains:

- its request/response types (mirrors of `guardian-api.ts`);
- its exported command methods with their final signatures, wired to the dispatcher, and
  unexported handler bodies returning `errNotImplemented`;
- its persisted state struct (`studyState`, `emergencyState`, `rewardsState`,
  `schedulesState`, `settingsState`, `attemptsState`, `pairingState`, `extRulesState`,
  `limitsState`),
  already part of `state.json` (add fields freely);
- the **hooks the core already calls** (no-ops until filled in), and the reducers of its
  events (`applyStudyStarted`…).

If a feature needs something the core does not offer, ask the core owner instead of
editing a core file.

## Commands

| Command | Endpoint | File | Idempotent |
| --- | --- | --- | --- |
| `Health` | `GET /v1/health` | queries.go | |
| `State` | `GET /v1/state` (ETag `"s-<stateVersion>"`) | queries.go | |
| `Diagnostics` | `GET /v1/diagnostics` | queries.go | |
| `CreateBlock` | `POST /v1/blocks` (201) | blocks.go | yes |
| `ListBlocks` | `GET /v1/blocks` | blocks.go | |
| `GetBlock` | `GET /v1/blocks/{id}` | blocks.go | |
| `ExtendBlock` | `POST /v1/blocks/{id}/extend` | blocks.go | yes |
| `ListSchedules`, `CreateSchedule`, `UpdateSchedule`, `DeleteSchedule` | `/v1/schedules…` | schedules.go | create |
| `ListLimits`, `CreateLimit`, `UpdateLimit`, `DeleteLimit` | `/v1/limits…` | limits.go | create |
| `ReportUsage` | `POST /v1/usage` (app or ext; a report: accepted in safe mode) | limits.go | |
| `StartStudy`, `CurrentStudy`, `GetStudySession`, `StudyHeartbeat`, `StudyStrike`, `PauseStudy`, `ResumeStudy`, `EndStudy`, `SetStudyOutcome` | `/v1/study/sessions…` | study.go | start, strike, end |
| `ReportAttempt` | `POST /v1/attempts` | attempts.go | |
| `Points` | `GET /v1/points` | queries.go | |
| `Events` | `GET /v1/events` (long poll) | queries.go | |
| `EmergencyPreview`, `RequestEmergency`, `CancelEmergency`, `ConfirmEmergency` | `/v1/emergency…` | emergency.go | request, confirm |
| `ListRewards`, `RedeemReward` | `/v1/rewards…` | rewards.go | redeem |
| `GetSettings`, `UpdateSettings` | `/v1/settings` | settings.go | |
| `CreatePairingCode`, `ClaimPairing`, `ListExtensions`, `RevokeExtension`, `AuthenticateExtension` | `/v1/pairing…` | pairing.go | |
| `GetExtRules`, `RulesPublicKey` | `GET /v1/ext/rules` | extrules.go | |
| `ExtHeartbeat` | `POST /v1/ext/heartbeat` | pairing.go | |
| `NuclearHeartbeat` | `POST /v1/nuclear/heartbeat` | study.go | |
| `DeleteData` | `POST /v1/data/delete` | datadelete.go | yes |
| `TestClock` | `POST /v1/_test/clock` (testhooks builds) | testclock.go | |

Internal inputs: `Step` (one tick), `ReportProcessKilled` (process watcher), the hosts
watcher notice, calibration answers. Outside the engine goroutine: `HasActive` /
`HasActiveBlocks` (the `has-active` CLI, works with the service stopped), `Matcher`,
`EncodeResponse`.

API-layer contract: decode bodies strictly, pass `Request{Scope, ExtensionID, Idem}`,
encode every body with `EncodeResponse`, map `*APIError` to `{"error":{code, message,
details}}` with `APIError.Status()`, write `*ReplayedResponse` verbatim with
`Idempotent-Replayed: true`, and answer 304 when `If-None-Match` equals the returned
`stateVersion`.

## How to add a handler

1. Put the request/response types in your feature file, mirroring `guardian-api.ts`.
2. Add the exported method with the dispatcher:

   ```go
   func (e *Engine) DoThing(ctx context.Context, r Request, req ThingRequest) (ThingResponse, error) {
       return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (ThingResponse, error) {
           return e.doThing(req)
       })
   }
   ```

   `write` makes frozen/safe mode refuse it; `idem`/`status` store the response for
   replays. Reads use `cmdOpts{}`.
3. In the handler: validate (return `issueErr(path, issue, msg)` or `apiErr(code, msg,
   details)`; codes and statuses come from the embedded table), build a batch with
   `b := e.newBatch()` and `b.add(EvType, Data{…})` (recorded points are derived for you),
   then `if err := e.commit(b); err != nil { return …, err }` (503 `read_only` on a store
   failure, nothing applied). Build the response **after** the commit, from state.
4. Change state only in the reducer of your event (`applyXxx(ev *storeEvent) error`),
   never in the handler: replay must rebuild the same state.
5. Time-driven work goes in your step hook (`studyStep`, `emergencyStep`,
   `expireAllowances`, `activateSchedules`, `limitsStep`, `applyPendingSettings`), using `e.now`
   (trusted ms), `e.bootNow`/`e.awakeNow` and `e.commitNow(b, "what")`.
6. Never use `time.Now()` for rules, never literals for values that exist in
   `internal/embedded`, never shell out with request data.

## Tests

`go test ./internal/engine` (and `-race`). `helpers_test.go` builds a data directory in
`t.TempDir()` with every fake: no admin rights, no real hosts file, no network. Without
`Start` nothing runs in the background and `Step` runs exactly one tick, so time is fully
deterministic (`FakeClock.Advance`, `Suspend`, `JumpWall`, `Reboot`, `RebootAfter`,
`ServiceRestart`).
