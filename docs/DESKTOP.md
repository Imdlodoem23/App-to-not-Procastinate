# Céntrate desktop: architecture (Phase 1 + Phase 5 contract)

Sections 1–14 describe Phase 1 (the blocking core). **Section 15 is the Phase 5 contract**
(statistics, rewards, achievements, schedules, exam whitelist, Pomodoro, sounds, reminders,
mini timer, OSD, Nuclear overlay, updater, onboarding, active window): its channels, state,
fixtures and owners. Where they disagree, §15 wins.

The engineering contract of `apps/desktop`. The product brief is `PROMPT.md` (§4, §5 «App de
escritorio», §7, §9 and, above all, §10, which is the design brief and wins over anything
here). The guardian contract is `docs/ARCHITECTURE.md` (§1, §8, §9.2, §14) and
`packages/shared/src/guardian-api.ts`. Colors, sizes and fonts come only from
`packages/shared/src/design/tokens.css` / `tokens.ts`.

**Compile-checked contract.** The lead owns these files. Every builder compiles against them,
and they change only through the lead:

| File                                                                                 | What it pins                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `apps/desktop/src/shared/ipc.ts`                                                     | IPC channels, payloads, `CentrateBridge`, handler table types          |
| `apps/desktop/src/shared/ui-state.ts`                                                | `UiState` model, defaults, timings, canonical selectors, draft helpers |
| `apps/desktop/src/shared/features.ts`                                                | Feature flags (Phase 5: all on except `study`)                         |
| `apps/desktop/src/shared/fixtures.ts`                                                | Every harness state, display presets, guardian payload builders        |
| `apps/desktop/src/shared/format.ts`                                                  | Numbers, clock, countdown, remaining time, target labels               |
| `apps/desktop/src/shared/i18n/{es,en}.ts`                                            | Strings shared by main and renderers                                   |
| `apps/desktop/src/shared/{prefs,stats,platform}.ts`                                  | Phase 5 prefs (validators), statistics shapes, platform state (§15)    |
| `apps/desktop/src/shared/ipc-payloads.ts`, `phase5-stubs.ts`                         | Phase 5 payload validators; stub handlers until PLATFORM lands (§15.6) |
| `apps/desktop/src/main/contracts.ts`                                                 | `Core`, `CoreHost`, `WindowHost`, `HarnessApi`, harness args           |
| `apps/desktop/src/preload/index.ts`, `index.d.ts`                                    | The generic bridge (`window.centrate`)                                 |
| `apps/desktop/vitest.config.ts`, `tsconfig.*.json`, `types/`, `package.json` scripts | Test and typecheck plumbing                                            |

The contract's own tests are `apps/desktop/test/shared/*.test.ts` (plus the shared payload
examples `test/shared/phase5-payloads.ts`).

---

## 1. Principles

1. **The guardian is the truth.** Nothing looks active until the guardian's 201. The countdown
   is `Date.parse(endsAt) − now`, computed from every snapshot. The UI never shortens anything
   and never shows an optimistic end.
2. **Main owns every piece of state and every timer that matters.** That covers polling, event
   sync, the «Bloqueando…» create, the 5 s extend queue, notifications, tray and window title.
   Renderers draw one `UiState` and own only input state: the text being typed, the card, the
   armed «¿Seguro?» and the detail forms.
3. **Everything visible is a function of a serialisable `UiState`.** A harness state is a
   fixture, and a screenshot is that fixture rendered.
4. **Pure first.** Logic worth testing is pure TypeScript with no DOM, Node or Electron imports,
   and runs under vitest in Node. That covers view models, geometry, policies, reducers and
   formatting. Electron glue stays thin: `electron` is imported only by `index.ts`, `app/`,
   `windows/`, `tray/`, `ipc-handlers.ts` and the notification adapter.
5. **Typed IPC that never throws.** Fallible invokes return `CommandResult`. The guardian
   token never leaves main.
6. **Two long-lived windows.** The main window is created hidden at startup. One detail window
   is pre-warmed about 1 s later and reused for every door. Nothing is created on a click.
7. **One renderer bundle.** `index.html?window=main|detail`, with detail views lazy-loaded.
   There is one CSP, one tokens stylesheet and one store per window. Later windows (mini timer, OSD, Nuclear)
   join behind flags; only the camera window (Phase 4) gets its own entry.
8. **Hidden means quiet.** While hidden: no 2 s poll, no renderer timers and under 1 % CPU.
   The tray and the title are updated by main from its minute timer.
9. **Flags hide features.** They never grey them out (§9).
10. **No new runtime dependencies.** No router, date, i18n or state-machine library.

This design merges two proposals:

- From A: the pure core, typed contracts, the show handshake, the undo-queue rules, the
  notification policy and the rich harness.
- From B: main owning all timers, snapshot pushes also reaching hidden windows, the fake
  guardian inside main, `prefs.json`, and the tray «Ampliar» sharing the queue.

---

## 2. Processes and windows

```text
 ┌─ main process ───────────────────────────────────────────────────────────────┐
 │ index.ts (bootstrap, lifecycle) · app/ · windows/ (main + detail, geometry)  │
 │ tray/ (icon, tooltip, menu, window title)           ◀── reads the snapshot   │
 │ Core = guardian/ + db/ + notifications/ + logs/ + system/                    │
 │   snapshot store ◀── poller · event sync · create · extend queue             │
 │   GuardianClient (Node fetch; token from <sys>/client.json) ──▶ guardian     │
 │ ipc-handlers.ts (invoke) · windows/ipc-window.ts (send)                      │
 └───────────────┬──────────────────────────────────────────────────────────────┘
                 │ contextBridge: invoke / send / on (UiSnapshot pushed on rev)
 ┌───────────────▼──────────────────┐   ┌──────────────────────────────────┐
 │ main window (440 DIP)            │   │ detail window (600 DIP, reused)  │
 │ ?window=main                     │   │ ?window=detail                   │
 │ Aviso · Bloqueo · Progreso · Pie │   │ Bloqueos | Emergencia | Ajustes  │
 └──────────────────────────────────┘   └──────────────────────────────────┘

 guardian = system service, HTTP JSON on 127.0.0.1:47600, reached from main only
```

---

## 3. Module layout and ownership

```text
apps/desktop/
  electron.vite.config.ts            LEAD (unchanged: node:sqlite is externalized by default, checked)
  vitest.config.ts                   LEAD  test/**/*.test.ts(x), node env, TZ=Europe/Madrid
  tsconfig.node.json                 LEAD  main, preload, shared, test, types/
  tsconfig.web.json                  LEAD  renderer, shared, preload/*.d.ts
  tsconfig.e2e.json                  LEAD  e2e/, playwright.config.ts, scripts/*.mts, shared, main/contracts.ts
  types/node-webcrypto.d.ts          LEAD  CryptoKey for guardian-api under Node types
  package.json                       LEAD scripts · dependencies: coordinator only
  playwright.config.ts               HARNESS
  scripts/ui-capture.mjs             HARNESS
  scripts/gen-tray-icons.mjs         MAIN-WINDOW (@resvg/resvg-js, root devDependency)
  resources/assets/tray/*.png        MAIN-WINDOW (generated, committed; already packaged via extraResources "assets")
  src/
    shared/                          LEAD  ipc.ts, ui-state.ts, features.ts, fixtures.ts, format.ts, i18n/es.ts
    preload/                         LEAD  index.ts, index.d.ts (generic; adding a channel never touches them)
    main/
      contracts.ts                   LEAD
      index.ts                       MAIN-WINDOW  bootstrap order (§8.1), lifecycle, wiring
      app/**                         MAIN-WINDOW  single instance, security hardening, autostart, theme, harness API
      windows/**                     MAIN-WINDOW  main + detail windows, geometry (pure), show path, WindowHost/CoreHost,
                                                  ipc-window.ts (every send channel)
      tray/**                        MAIN-WINDOW  controller, pure model (icon key, tooltip, menu, window title), i18n/es.ts
      guardian/**                    MAIN-GUARDIAN core.ts (createCore), client-json, connection, poller, event-sync,
                                                  create, extend-queue, emergency, fake-guardian, store
      db/**                          MAIN-GUARDIAN events (node:sqlite), prefs.json + templates store
      notifications/**               MAIN-GUARDIAN policy (pure), Electron adapter, i18n/es.ts
      logs/**                        MAIN-GUARDIAN rotating app log
      system/**                      MAIN-GUARDIAN diagnostics, repair, running process names
      ipc-handlers.ts                MAIN-GUARDIAN registerIpcHandlers (every invoke channel)
      ipc-guards.ts                  MAIN-GUARDIAN payload validators per invoke channel
    renderer/
      index.html                     RENDERER-CORE (keep the CSP meta)
      src/main.tsx, src/index.css    RENDERER-CORE
      src/app/**                     RENDERER-CORE MainWindow and DetailWindow shells, bridge, harness loader, ErrorBoundary
      src/components/**              RENDERER-CORE UI kit (§7.3)
      src/store/**                   RENDERER-CORE Zustand store (§7.1)
      src/hooks/**                   RENDERER-CORE useNow, useCountdown, useAutoLayout, useHelp, useArmed, useKeys
      src/i18n/**                    RENDERER-CORE shell, kit, sections 1/4/5, error copy (§7.5)
      src/styles/**                  RENDERER-CORE
      src/sections/protection/**     RENDERER-CORE section 1 (ProtectionWarning)
      src/sections/progreso/**       RENDERER-CORE section 4 (header + daily goal bar)
      src/sections/footer/**         RENDERER-CORE section 5
      src/sections/bloqueo/**        BLOQUEO       section 2, every state (§7.6), its i18n/es.ts
      src/windows/bloqueos/**        DETAILS
      src/windows/emergencia/**      DETAILS
      src/windows/ajustes/**         DETAILS
  test/shared/**                     LEAD
  test/main/{windows,tray,app}/**    MAIN-WINDOW
  test/main/{guardian,db,notifications,logs,system,ipc}/**  MAIN-GUARDIAN
  test/renderer/core/**              RENDERER-CORE
  test/renderer/bloqueo/**           BLOQUEO
  test/renderer/windows/**           DETAILS
  e2e/**                             HARNESS
docs/ui/**                           HARNESS (index.html + PNGs)
docs/DESKTOP.md                      LEAD
```

Rules:

- Touch only your paths. A change you need in someone else's path goes in your report as an
  open issue for that owner.
- Every owner writes vitest tests for its pure modules under its `test/` folder.
- Strings live next to their code in `i18n/es.ts`: `src/main/tray/i18n/es.ts`,
  `src/main/notifications/i18n/es.ts`, `src/renderer/src/i18n/es.ts`,
  `src/renderer/src/sections/bloqueo/i18n/es.ts`, and
  `src/renderer/src/windows/<name>/i18n/es.ts`. Only strings shared across processes go in
  `src/shared/i18n/es.ts`.
- Colors come only from tokens (Tailwind token classes or `tokens.ts`). A prop that takes an
  accent is called `tone` or `accent`, never `color` (`scripts/lint-colors.mjs`). Text never
  uses `text-red`: use `text-red-text` or `text-fg-muted`.

### 3.1 Contracts between main-process owners (`src/main/contracts.ts`)

- **MAIN-GUARDIAN** exports `createCore(options: CoreOptions): Core` from
  `src/main/guardian/core.ts`, and `registerIpcHandlers(core: Core, host: WindowHost): () => void`
  from `src/main/ipc-handlers.ts`.
  - The handler registration calls `ipcMain.handle` for every `INVOKE_CHANNELS` entry.
  - For each call it first resolves the sender:
    `host.windowOf({ webContentsId: e.sender.id, frameUrl: e.senderFrame?.url ?? null })`, and
    rejects when that returns `null`.
  - It then validates the payload with `ipc-guards.ts`. A fallible channel answers a bad
    payload with `fail(uiError('rejected', 'validation_failed', 422))`.
  - It answers `app:init` with `{ ...host.initPayload(window), snapshot: core.getSnapshot() }`.
  - It never lets an exception escape a `CommandResult` channel.
- **MAIN-WINDOW** implements `CoreHost` and `WindowHost` in `src/main/windows/**` and
  registers every **send** channel in `src/main/windows/ipc-window.ts`. It forwards
  `block:create-dismiss` to `core.sendHandlers`. It subscribes to `core.subscribe` to push
  `ui:snapshot` to both windows and to update tray and title. It calls
  `core.visibilityChanged()` on every show, hide, focus or blur. It installs `HarnessApi` on
  `globalThis[HARNESS_GLOBAL]` in harness mode.
- Tray «Ampliar ▸» calls `core.handlers['block:extend']` (the same queue as the tiles) and shows
  the main window, so the undo line is visible (the OSD is off in Phase 1).

### 3.2 Contracts between renderer owners

- **Section and window entry points.** BLOQUEO exports `BloqueoSection` (no props) from
  `src/renderer/src/sections/bloqueo/index.ts`. DETAILS exports a default component (no props)
  from `src/renderer/src/windows/{bloqueos,emergencia,ajustes}/index.tsx`. RENDERER-CORE's
  shells import them: `MainWindow` statically, `DetailWindow` with `React.lazy`.
- The **store** (§7.1), the **UI kit** (§7.3), the hooks (§7.4) and the **error copy**
  (`errorCopy`, §7.5) are RENDERER-CORE's. BLOQUEO and DETAILS use them and do not build
  parallel versions.
- **Pure view models.** Each section or window keeps a pure `view.ts`:
  `deriveBloqueoView(state: UiState, nowMs: number)` and similar. It returns labels, tones and
  visibility, and is unit-tested. Components only map a view model to the kit.

---

## 4. IPC (`src/shared/ipc.ts`)

Every payload is plain structured-cloneable data. Main checks the sender frame
(`WindowHost.windowOf`) and the payload shape before handling anything. The window kind comes
from the sender, never from the payload. The preload refuses channels outside the lists.

### 4.1 Invoke (renderer → main, awaited)

| Channel                 | Request → result                                                                      | Handler                                                 | Callers                                             |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `app:init`              | `null` → `InitPayload` (window, platform, snapshot, layout, detail, visible, harness) | ipc-handlers (+ `WindowHost`)                           | every renderer                                      |
| `block:create`          | `{intentId, request: CreateBlockRequest}` → `CommandResult<{blockId}>`                | Core (create)                                           | BLOQUEO                                             |
| `block:create-retry`    | `{intentId}` → `CommandResult<{blockId}>` (same request, same key)                    | Core                                                    | BLOQUEO                                             |
| `block:extend`          | `{blockId, addMinutes}` → `CommandResult<{entryId, commitAt}>`                        | Core (extend queue)                                     | BLOQUEO (+ tray)                                    |
| `block:extend-undo`     | `{entryId}` → `'undone' \| 'too_late'`                                                | Core                                                    | BLOQUEO                                             |
| `block:extend-retry`    | `{entryId}` → `CommandResult<null>`                                                   | Core                                                    | BLOQUEO                                             |
| `emergency:preview`     | `{blockIds \| null}` → `CommandResult<EmergencyPreviewResponse>`                      | Core                                                    | DETAILS                                             |
| `emergency:request`     | `{intentId, blockIds, phrase}` → `CommandResult<EmergencyUnlock>`                     | Core                                                    | DETAILS                                             |
| `emergency:cancel`      | `{id}` → `CommandResult<EmergencyUnlock>`                                             | Core                                                    | DETAILS                                             |
| `emergency:confirm`     | `{intentId, id}` → `CommandResult<ConfirmEmergencyResponse>`                          | Core                                                    | DETAILS                                             |
| `schedules:list`        | `null` → `CommandResult<Schedule[]>`                                                  | Core                                                    | DETAILS                                             |
| `schedules:set-enabled` | `{id, enabled}` → `CommandResult<Schedule>` (PUT with the schedule's own fields)      | Core                                                    | DETAILS                                             |
| `templates:save`        | `TemplateInput` → `CommandResult<BlockTemplate[]>`                                    | Core (prefs store)                                      | DETAILS                                             |
| `templates:delete`      | `{id}` → `CommandResult<BlockTemplate[]>` (built-ins cannot be deleted)               | Core                                                    | DETAILS                                             |
| `prefs:set`             | `UiPrefsPatch` → `CommandResult<UiPrefs>`                                             | Core; MAIN-WINDOW reacts to snapshot (theme, autostart) | DETAILS (main records `lastReason` itself on a 201) |
| `pairing:new-code`      | `null` → `CommandResult<PairingCodeResponse>`                                         | Core                                                    | DETAILS                                             |
| `diagnostics:copy`      | `null` → `CommandResult<{source}>` (main writes the clipboard)                        | Core (system/diagnostics)                               | DETAILS                                             |
| `data:delete`           | `{intentId, confirm}` → `CommandResult<DeleteDataResponse>`                           | Core                                                    | DETAILS                                             |
| `guardian:repair`       | `null` → `CommandResult<{outcome}>`                                                   | Core (system/repair)                                    | RENDERER-CORE, BLOQUEO, DETAILS                     |
| `system:process-names`  | `null` → `CommandResult<string[]>`                                                    | Core (system/processes)                                 | DETAILS                                             |

### 4.2 Send (renderer → main, fire-and-forget)

| Channel                | Payload            | Handler (MAIN-WINDOW unless noted)                        |
| ---------------------- | ------------------ | --------------------------------------------------------- |
| `window:layout`        | `LayoutReport`     | Anchored `setContentBounds` (§8.3); detail window follows |
| `window:show-ack`      | `{seq, layout}`    | Completes the show handshake (§8.2)                       |
| `window:ready`         | `{stateId, rev}`   | Harness readiness                                         |
| `window:hide`          | `null`             | Hide main (and detail)                                    |
| `window:open-detail`   | `DetailRequest`    | Push `ui:detail`, set title, place, show, focus           |
| `window:close-detail`  | `null`             | Hide detail                                               |
| `window:confirm-draft` | `{draft}`          | Show and focus main, push `ui:command {confirm-draft}`    |
| `block:create-dismiss` | `{intentId}`       | `core.sendHandlers` (drops a failed create)               |
| `app:open-guide`       | `{guide: GuideId}` | `shell.openExternal` of a fixed URL per guide (allowlist) |
| `app:quit`             | `null`             | `app.quit()` → `core.shutdown(1500)` first                |
| `app:renderer-error`   | `{message, stack}` | Log (MAIN-GUARDIAN logger)                                |

### 4.3 Push (main → renderer)

| Channel           | Payload                                  | When                                                                                                |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ui:snapshot`     | `UiSnapshot`                             | Every `rev` change, to both windows, visible or not (never on a 304)                                |
| `ui:layout`       | `WindowLayout`                           | Display metrics changed, fake display switched                                                      |
| `ui:visibility`   | `{visible, focused, reason, focusField}` | Show, hide, focus, blur                                                                             |
| `ui:prepare-show` | `{seq, layout}`                          | Before every show of the main window                                                                |
| `ui:detail`       | `DetailRequest`                          | Detail window retargeted                                                                            |
| `ui:command`      | `UiCommand`                              | Tray «Bloqueo rápido ▸» (`confirm-template`), Bloqueos «Bloquear…» (`confirm-draft`), `focus-field` |
| `ui:harness`      | `HarnessLoad`                            | Harness only: replace renderer-local state                                                          |

Traffic: at most one snapshot per real change (about 0.5 per second while a block runs and the
window is visible, 0 on a 304) and nothing per second. The countdown ticks locally.

---

## 5. State model (`src/shared/ui-state.ts`)

`UiState = { env: RenderEnv; snapshot: UiSnapshot; main: MainLocalState; detail: DetailLocalState }`.

- **`UiSnapshot`** is owned by main and replaced whole on each push. Renderers ignore any `rev`
  that is not newer. It contains:
  - `link`: `connecting | ok | down` and its reason;
  - `state`: the last good `/v1/state`, kept while the guardian is down;
  - `health`;
  - `ops`: `create`, `lastCreated` and `extendQueue`;
  - `prefs`, `templates`, `features`, `app`;
  - `harness`: `{stateId, frozenNowMs}` or `null`.
- **`MainLocalState`** is owned by the main window renderer: `composer`, `card` (the
  confirmation card with draft, step and consequence time), `extendOther`, `armed` and `help`.
- **`DetailLocalState`** is owned by the detail renderer: the Bloqueos form and inputs, the
  Emergencia phrase and result, the Ajustes pairing code, BORRAR word and diagnostics
  feedback, plus `armed` and `help`.
- **`RenderEnv`**: `window`, `platform`, `layout` (`maxContentHeight`, `anchor`), `detail`
  (the current `DetailRequest`) and `visible`.

Only fixture-settable state lives in the local parts. Hover animation and focus rings are
component state.

**Canonical selectors** (use them; never re-derive their meaning):

- `primaryBlock` (`blocks[0]`, latest end) and `secondaryBlocks`;
- `activePunishment`;
- `finishedNotice` (completed manual or schedule blocks within 60 s, points summed);
- `isBootHold`;
- `bloqueoVariant`;
- `reconcileMainLocal`;
- `queuedExtendMinutes` and `maxExtendMinutes` (the 24 h rule, 0 for punishments);
- `modeAccent` (normal blue, strict orange, hardcore and exam red);
- `snapshotNow` (the frozen harness clock or `Date.now()`).

**Draft helpers** are shared by the card, the Bloqueos form, templates and fixtures:

- `draftFromParse` returns `null` unless the phrase was fully understood;
- `draftSeedFromParse` and `draftFromSeed` fill visible form defaults: 60 min, the default
  mode, the last reason;
- `draftFromTemplate`;
- `withMode`: Examen keeps the targets aside and leaving it restores them;
- `draftMinutes`, `draftNeedsConsequence` (over 4 h, Hardcore or Examen), `draftProblem`;
- `draftToCreateRequest`: exam ⇒ whitelist, and the acknowledgements.

**Timings** (`UI_TIMINGS`, one number per meaning):

| Constant                     | Value                    |
| ---------------------------- | ------------------------ |
| Undo                         | 5 s                      |
| Arm                          | 3 s                      |
| Consequence lock             | 2 s                      |
| Finished line                | 60 s                     |
| Example rotation             | 4 s                      |
| Request timeout              | 3 s                      |
| Poll                         | 2 s visible, 60 s hidden |
| Link retry                   | 1 s                      |
| Warning                      | ≤ 5 s                    |
| Notifications                | ≤ 1 per minute           |
| Five-minute notice           | 5 min                    |
| Block-end refresh            | + 300 ms                 |
| Show budget                  | 150 ms                   |
| Show acknowledgement timeout | 50 ms                    |
| Tray blur grace              | 250 ms                   |

### 5.1 Where each element gets its data

| UI element                             | Source                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section 1, red                         | See the list below the table                                                                                                                                                       |
| Section 1, orange                      | `state.blocks.length > 0 && state.protection.browsersWithoutExtension.length > 0` → «Chrome no tiene la extensión: ahí el bloqueo puede tardar» · **Instalar…** (`app:open-guide`) |
| Bloqueo header, idle                   | «Bloqueo: ninguno» · `state.nextSchedule.startsAt` → «Próximo horario: 18:00»                                                                                                      |
| Bloqueo, active                        | `primaryBlock`: targets (`targetsLabel`), mode, `endsAt` («hasta 17:42»), countdown, `modeAccent` bar, `reason` in italics                                                         |
| Other blocks                           | `secondaryBlocks`: 28 px rows (at most 2), then «y N más…» → Bloqueos (`focus: 'active'`)                                                                                          |
| Extend row and undo line               | `maxExtendMinutes` (disabled tiles give the reason on the help line); `ops.extendQueue` for the primary block → «+30 min · termina a las 18:12 · Deshacer (4 s)»                   |
| Emergency line                         | See the list below the table                                                                                                                                                       |
| Punishment                             | `activePunishment`: «Castigo: todas las distracciones · 60 min», «3 strikes en "mates"», «−100 puntos» (`POINT_RULES.punishmentPenalty`)                                           |
| Finished                               | `finishedNotice` → «Bloqueo: terminado» · «Hecho. +80 puntos» (green)                                                                                                              |
| Boot hold                              | `isBootHold` → «Comprobando la hora…» instead of 0:00                                                                                                                              |
| «Bloqueando…», failed                  | `ops.create` (both windows agree because it lives in main)                                                                                                                         |
| Progreso                               | `state.points`: «Nivel 7 · 1.240 puntos» · «Racha: 5 días»; balance < 0 → red text + «Números rojos» pill; 4 px bar «Hoy: 42 de 60 min»                                            |
| Footer                                 | `link` + `state.protection.extensions.some(e => e.connected)`; `app.version` / `app.updateVersion`                                                                                 |
| Tray icon, tooltip, menu; window title | The snapshot + main's clock (§8.6)                                                                                                                                                 |
| Ajustes › Sistema                      | `link`, `health.version`, `state.protection` (hosts, watcher, extensions)                                                                                                          |

**Section 1, red.** One of these, in priority order:

- `link.status === 'down'`, worded by reason:
  - `not_installed`: «Guardián no instalado: ahora mismo no se bloquea nada» · **Instalar…**;
  - `unreachable` or `timeout`: «Guardián detenido: ahora mismo no se bloquea nada» ·
    **Reparar | Detalles…**;
  - `unauthorized` or `incompatible`: «Actualiza el guardián» · **Reparar**.
- `state.guardian.mode !== 'normal'`: «Guardián en modo seguro: no se pueden crear bloqueos» ·
  **Detalles…**.
- A block is active and `protection.hosts.ok` or `processWatcher.ok` is `false`: «El bloqueo no
  se está aplicando del todo» · **Reparar | Detalles…**.

«Detalles…» opens Ajustes (`group: 'sistema'`).

**Emergency line.** Chosen from the snapshot:

- `state.emergency` counting or ready: «Emergencia: 8:12» / «Emergencia: lista» → Emergencia.
- Otherwise, the primary block has `emergencyEligible`: «Desbloqueo de emergencia…».
- Otherwise, its mode is hardcore or exam: «Hardcore: no se puede cancelar» / «Examen: no se
  puede cancelar».

Section 1 shows at most one warning: red before orange.

Data that is **not** in the snapshot is fetched by the detail window when a view opens, and
kept in component state (in harness mode the fake guardian answers from `fixture.fake`):

- the emergency preview;
- schedules;
- running process names.

Results a screenshot must be able to show live in `DetailLocalState` instead: the new pairing
code (`ajustes.pairing`) and the confirmed emergency (`emergencia.result`).

`GET /v1/points` is not polled, because `state.points` is the same summary.
`GET /v1/settings` is not used in Phase 1: the daily goal is read from
`state.points.today.goalMinutes`.

---

## 6. Main process services (MAIN-GUARDIAN unless noted)

### 6.1 Guardian link and polling

**`client.json`** lives in `<sys>`:

- `%ProgramData%\Centrate`, `/Library/Application Support/Centrate` or `/var/lib/centrate`;
- overridden by `CENTRATE_DATA_DIR` only when unpackaged: the guardian's own test variable.

It is read at startup and re-read when its mtime changes or after a 401 (`TokenSource`
function). If it is missing, the link is `down` / `not_installed`.

**Client.**
`createGuardianClient({ baseUrl: guardianBaseUrl(port), token: () => source.token(), fetch: globalThis.fetch })`.
Node's `fetch` sends no `Origin`. Never use `net.fetch`.

**Cadence.**

| When                                           | What                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Any window visible                             | `getState({etag})` every 2 s, as a `setTimeout` chain that never overlaps     |
| Hidden                                         | Every 60 s, on each event batch, on `powerMonitor` `resume` / `unlock-screen` |
| Always                                         | At `Date.parse(blocks[0].endsAt) + 300 ms`                                    |
| After every write                              | Immediately                                                                   |
| Start, link recovery, every 60 s while visible | `health()`                                                                    |

A 304 only marks the link ok and publishes nothing. `apiVersion !== 1` sets the link to
`down` / `incompatible`.

**Link rule.**

- A failed request increments `failures` and schedules one retry after 1 s.
- A second consecutive failure sets the link to `down`, with the reason from `toUiError`.
- Any success sets `ok` and `failures: 0`.
- The warning therefore shows 1–3 s after a real failure (≤ 5 s) and never on one blip.
- The last good state stays under the warning.

**No stale overwrite.** Keep `minStateVersion` = the highest `stateVersion` from a 201 or an
extend response. A poll body older than that is dropped.

**Event sync.**

- Always on, whether visible or hidden.
- Request: `getEvents({epoch, after, limit: 500, waitMs: hasMore ? 0 : 25000})`, one long
  poll.
- Backoff on failure: 1, 2, 5, 10 and 30 s.
- `kick()` runs on resume and after writes.
- Each page is inserted in **one** sqlite transaction together with the cursor. On `reset`,
  wipe first.
- After the transaction: the notification policy ingests the page (§6.4), then
  `refreshNow('event')`.
- Unknown and malformed events are stored raw and still advance the cursor.

### 6.2 Create («Bloqueando…», 3 s)

1. Validate `request` with `isCreateBlockRequest`, and `intentId` with `isIntentId`.
2. If the link is already `down` because the connection was refused, fail fast.
3. Set `ops.create = {status: 'sending'}` and publish. Every window shows «Bloqueando…» as a
   label only, with no spinner.
4. Call `createBlock(request, {idempotencyKey: intentId})` with a 3 s timeout.
5. **On 201**, in the same publish:
   - clear `create`;
   - set `lastCreated`;
   - insert `response.block` into `state.blocks` (sorted);
   - raise `minStateVersion`;
   - set `prefs.lastReason` when the reason is not empty.

   Then `refreshNow('write')`. The renderer closes the card in that render
   (`reconcileMainLocal`).

6. **On timeout or unreachable**: `status: 'failed'` with the `UiError`. The card shows «El
   guardián no responde · Reintentar · Reparar». «Reintentar» (`block:create-retry`) resends
   the **same request with the same key**, so a request that landed during the timeout replays
   and never duplicates.
7. **On a guardian 4xx**: `failed` with a `rejected` error. The card stays editable, with the
   copy on its help line (§7.5).

### 6.3 Extend queue (5 s undo)

Nothing reaches the guardian before `commitAt`. The key is generated when the entry becomes
due and is reused on retries.

- A click on a block with a `waiting` entry adds its minutes and restarts `commitAt`. For
  example, +15 then +30 becomes «+45 min · termina a las 18:27».
- Before accepting a click, check that the block is not a punishment and that
  `remaining + queued + add ≤ 1440`, using `maxExtendMinutes`. Otherwise answer
  `extension_exceeds_max` or `not_extendable`.
- «Deshacer» only removes a `waiting` entry. After `commitAt` it answers `too_late`, shown as
  «Ya ampliado».
- At `commitAt` the entry becomes `sending`, and `extendBlock(id, {addMinutes}, {idempotencyKey})`
  is called.
  - Timeout or unreachable: two retries with the same key (1 s, then 2 s), then `failed` with
    «No se pudo ampliar · Reintentar».
  - 409 `block_not_active`: drop the entry with «El bloqueo ya terminó».
  - 422: map it (`details.maxAddMinutes`).
  - On 200: drop the entry, raise `minStateVersion` and refresh.
- The countdown, header, tray and title show only the guardian's `endsAt`. Only the undo line
  shows `projectedEndsAt`.
- The queue lives in main, so it survives hiding the window, and the tray «Ampliar ▸» uses it.
- `core.shutdown` («Salir») **sends** waiting entries: the user asked for them and did not
  undo.

### 6.4 Notifications (`notifications/policy.ts` pure, `notifications/notifier.ts` Electron)

**Kinds and sources:**

| Kind              | Source                                                                                                                          | Copy                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Block started     | `block_created` with `source` `user` or `schedule`                                                                              | «Bloqueo iniciado» / «YouTube hasta las 17:42»               |
| Five minutes left | A single main timer at `endsAt − 5 min` for blocks lasting ≥ 10 min, once per `(blockId, endsAt)`, recomputed on every snapshot | «Quedan 5 min»                                               |
| Block finished    | `block_completed` for `manual` or `schedule` blocks                                                                             | «Bloqueo terminado» / «Hecho. +80 puntos»                    |
| Attempt           | `attempt` with envelope `points < 0`                                                                                            | «Intento bloqueado: −10 puntos»                              |
| Close hint        | The first X; bypasses the 1-per-minute rule, shown immediately                                                                  | «Céntrate sigue en la bandeja. Los bloqueos siguen activos.» |

**Policy:**

- At most one OS notification per 60 s. Notices queued meanwhile are grouped at flush time.
- Priority: finished > started > five minutes > attempts.
- Attempts are summed: «3 intentos bloqueados: −70 puntos». A mixed group gets a body such as
  «También: 2 intentos (−30 puntos)».
- Stale notices are dropped at flush: five minutes when the block ended, started when the block
  is no longer active.
- Nothing is shown while the main window is visible and focused: the UI already shows it.
- Events older than 2 minutes, or read before the first caught-up page, never notify, so
  there is no storm after sleep or a restart.
- Clicking a notification calls `host.showMain('notification')`. A new notification closes
  the previous one.
- Windows needs `app.setAppUserModelId(APP_ID)` (MAIN-WINDOW, before `ready`).

### 6.5 Local data

**`userData/prefs.json`** holds `UiPrefs` and the templates. It is read **synchronously**
before any window exists, because it provides the theme and the background color. Writes are
atomic (temporary file, then rename), and each field is validated and falls back to its
default.

**`userData/centrate.sqlite`** uses `node:sqlite` `DatabaseSync`. It is externalized by
electron-vite, and `require('node:sqlite')` was verified inside Electron 44 (Node 24.21).
Settings: `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, and `user_version` migrations.

Schema v1 (events only in Phase 1; derived statistics tables arrive with the `stats` flag):

```sql
CREATE TABLE events (epoch TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL,
  wall_offset_ms INTEGER NOT NULL, day TEXT NOT NULL, points INTEGER NOT NULL, xp INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('known','unknown','malformed')), raw TEXT NOT NULL,
  PRIMARY KEY (epoch, seq)) STRICT;
CREATE INDEX events_day ON events(day);
CREATE TABLE sync_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT, last_seq INTEGER NOT NULL) STRICT;
```

A database that cannot be opened is renamed to `.corrupt-<ts>` and recreated. The guardian
still holds the epoch, so a bad database never stops the app from starting. Tests use
`:memory:`.

`CENTRATE_USER_DATA` moves `userData`, only when unpackaged, which gives each e2e run its own
data.

### 6.6 Diagnostics, repair, data deletion, logs

**«Copiar diagnóstico».** Main writes the clipboard; the text never crosses IPC.

- Normally: `GET /v1/diagnostics` plus app info (version, OS, link, the last 20 app-log lines).
- When the guardian does not answer: the health error code, the JSON of
  `centrate-guardian status` (`execFile`, fixed arguments, 5 s timeout), the last 200 lines of
  `<sys>/logs/guardian.log` and the app log tail.

**«Reparar».** Runs the bundled guardian with fixed arguments and elevation:

- `start`, or `install` then `start` when the service is not registered;
- Windows: `runas`; macOS: `osascript … with administrator privileges`; Linux: `pkexec`.

It answers `started`, `cancelled` (the user declined elevation) or `unsupported`. The exact
per-OS commands are an installer-owner follow-up (§14).

**«Borrar todos mis datos».** The user types BORRAR. Main calls `POST /v1/data/delete`, then
wipes the local events database, resets the templates and clears `lastReason`. It keeps the
theme, autostart and default mode.

**Logs.** `userData/logs/app.log`, rotated at 1 MiB × 3. They never contain reasons, domains,
tokens or pairing codes.

### 6.7 App shell services (MAIN-WINDOW)

**Autostart.**

- Windows and macOS: `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`.
- Linux: `~/.config/autostart/centrate.desktop` with `Exec=… --hidden`.
- On macOS, `wasOpenedAtLogin` also means hidden.
- It is applied from `snapshot.prefs.autostart` whenever that changes. The default is on.

**Theme.**

- `nativeTheme.themeSource = prefs.theme` drives the native title bar and
  `prefers-color-scheme`.
- On `nativeTheme` `updated`, update every window's `backgroundColor` with
  `colors[resolveTheme(prefs.theme, nativeTheme.shouldUseDarkColors)].bg`.
- The renderer also sets `<html data-theme="system|light|dark">`, which `tokens.css`
  understands.

**Security** (§11): the session hardening lives in `app/`.

---

## 7. Renderer

### 7.1 Store (RENDERER-CORE, `src/renderer/src/store/`)

```ts
export interface AppStore extends UiState {
  bridge: CentrateBridge;
  /** Last measured layout of this window (main window only). */
  layout: LayoutReport | null;
  /** Ignores rev ≤ current; applies reconcileMainLocal in the same set(). */
  applySnapshot(snapshot: UiSnapshot): void;
  updateMain(fn: (main: MainLocalState) => MainLocalState): void;
  updateDetail(fn: (detail: DetailLocalState) => DetailLocalState): void;
  setEnv(patch: Partial<RenderEnv>): void;
  /** Harness: replace both local parts (ui:harness). */
  loadHarness(load: HarnessLoad): void;
}
export function createAppStore(bridge: CentrateBridge, init: UiState): StoreApi<AppStore>;
export function useAppStore<T>(selector: (s: AppStore) => T): T; // from a React context
export function useAppStoreApi(): StoreApi<AppStore>;
```

- There is one store per window, created in `main.tsx` from `app:init`.
- Section-specific actions (submit card, extend, undo, emergency steps…) live in the owning
  section's folder as hooks. They call `bridge.invoke` plus `updateMain` / `updateDetail`, so
  nobody edits the store file for a feature.
- **Zustand 5 + React 19.** Selectors must return stable references:
  - select slices (`s => s.snapshot`, `s => s.main.card`);
  - use `useShallow` for objects;
  - derive view models in `useMemo`;
  - never build arrays or objects inside a selector (that loops forever).

### 7.2 Entry, windows and the show handshake

**Startup of `main.tsx`:**

1. Read `?window=main|detail`.
2. `getBridge()` returns `window.centrate`. In the browser harness (dev only, no preload)
   there is none, so it returns an in-memory bridge built from `?state=<id>` fixtures.
3. `await bridge.invoke('app:init', null)`.
4. `createAppStore`, then apply `init.harness` if present.
5. Subscribe to every `ui:*` push.
6. `createRoot().render(<StrictMode><ErrorBoundary>…)`.
7. After the first layout effect, send `window:ready`, and set
   `document.documentElement.dataset.harnessReady = stateId` in harness mode.

`window.onerror` and `unhandledrejection` report through `app:renderer-error`.

**`ui:prepare-show`.** Render the latest snapshot synchronously (`flushSync`), run the layout
decision (§7.4) synchronously and answer `window:show-ack {seq, layout}`. Forced layout works in
a hidden window even when `ResizeObserver` does not fire.

**`ui:visibility`.**

- Visible: start the timers. If `focusField`, focus «¿Qué quieres hacer?» synchronously
  (`preventScroll`); if a block hides the field, focus the section root instead.
- Hidden: stop every timer (countdown, example rotation, arming).

**`ui:command`.** `confirm-template` and `confirm-draft` open the card, with a new `intentId`
(`crypto.randomUUID()`) and a focused confirm button. `focus-field` focuses the field.

### 7.3 UI kit (RENDERER-CORE, `src/renderer/src/components/`)

It follows G-Helper's organisation with our tokens: no cards, shadows, gradients or icon-only
controls, and no solid-filled selected state.

| Component                                        | Props (essentials)                                                                                                                               | Rules                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Section`                                        | `id, icon, title, datum?, pill?, children`                                                                                                       | `<section aria-labelledby>`; 20 px header: 16 px icon, 13/600 «Cosa: valor», right-aligned 400 datum                                                                                                     |
| `TileRow`                                        | `id, label, columns: 3 \| 4, kind: 'group' \| 'radiogroup', help, children`                                                                      | 4 px gap; owns the 12 px help line (height reserved; hover/focus help replaces `help`; `aria-describedby`); arrow keys move focus                                                                        |
| `Tile`                                           | `id, label, icon?, help?, tone?, selected?, door?, disabled?, disabledReason?, armed?, mnemonic?, size?: 'regular' \| 'door' \| 'text', onPress` | 56/40/32 px (40 in compact, icon left); selected = 2 px accent outline + 12 % tint over the top 20 %; door = `tile-2` + «…»; disabled 45 % + reason on the help line; armed = red outline + «¿Seguro? …» |
| `ConfirmButton`                                  | `label, disabled?, onPress`                                                                                                                      | The only filled control (blue, `on-accent` text)                                                                                                                                                         |
| `HelpLine`                                       | `id, tone?: 'muted' \| 'red' \| 'orange' \| 'green', children`                                                                                   | 12 px, one line, never clipped (the view picks shorter copy)                                                                                                                                             |
| `Pill`, `Chip`, `StatusDot`, `Bar`               | `tone`; `Bar` `value 0..1, height 3 \| 4 \| 6`                                                                                                   | Pills 11/600, radius 4; dots 8 px; bars linear                                                                                                                                                           |
| `Countdown`                                      | `endsAt, size: 'big' \| 'row'`                                                                                                                   | Ticks itself (`nextTickDelay`), `splitCountdown`, seconds at 60 %, `tabular-nums`, `role="timer"` + `aria-label` (`countdownAria`), separate polite live region (`countdownAnnouncement`)                |
| `Field`                                          | `value, onChange, placeholder, size: 'main' \| 'normal', …`                                                                                      | Main field 44 px / 15 px                                                                                                                                                                                 |
| `Segmented`, `Toggle`, `Checkbox`, `SettingsRow` | the usual                                                                                                                                        | `Segmented` = radiogroup of tiles; `SettingsRow` 48 px, title + description left, control right                                                                                                          |

### 7.4 Hooks (RENDERER-CORE)

**`useNow(stepMs)`** returns `snapshotNow(snapshot)` and re-renders every `stepMs`, only while
visible. All renderer code reads time through it or through `Countdown`.

**`useAutoLayout(rootRef)`** runs in the main window:

```ts
function chooseLayout(measure: (d: Density) => number, max: number): LayoutReport {
  const regular = measure('regular');
  if (regular <= max) return { height: regular, density: 'regular', scroll: false };
  const compact = measure('compact');
  if (compact <= max) return { height: compact, density: 'compact', scroll: false };
  return { height: max, density: 'compact', scroll: true };
}
```

- `measure` sets `data-density` (and `data-measuring`, which lifts the scroll clamp) on
  `<html>` and reads `Math.ceil(content.getBoundingClientRect().height)` from a `flow-root`
  wrapper. It runs in `useLayoutEffect`, so the user never sees a flicker.
- Regular is always tried first, so no hysteresis is needed.
- It runs on every snapshot or local change and on `ResizeObserver`, batched per frame.
- It sends `window:layout` only when the report changed.
- In scroll mode only the section column scrolls, never the footer.

**`useHelp(rowId)`** manages the hover and focus help. **`useArmed(id)`** manages the 3 s
«¿Seguro?», disarmed by Esc or mouse leave. Both write the window's local state (`main.help`
/ `main.armed`, or `detail.help` / `detail.armed`), so fixtures can set them.

**`useKeys`** is one window-level key map with an **Esc cascade**. Sections register handlers
by priority, and the first one that returns `true` wins:

1. disarm;
2. close «Otro…»;
3. back from the consequence step;
4. close the card;
5. close the field opened with «Nuevo»;
6. clear the text;
7. `window:hide`. In a detail window, `window:close-detail`.

Other keys:

- **Enter** advances: field → card → consequence → create. A phrase that was not understood
  opens Bloqueos with the seed.
- **Ctrl+N** (Cmd+N on macOS), or **`/`** outside a text field, focuses the field.
- **Ctrl+E**, then **1 / 2 / 3 / 4** within 2 s: +15, +30, +1 h, «Otro…».
- **Arrow keys** move within a row.
- **Alt+letter** triggers the tile with that mnemonic. Mnemonics are unique among visible tiles
  and underlined while Alt is held.
- Ctrl+Shift+S belongs to the study flag.

**Focus and targets.** The focus ring is 2 px blue, on `:focus-visible` only, with a 2 px
offset. Click targets are at least 32×32.

### 7.5 Error copy (RENDERER-CORE, `src/renderer/src/i18n/errors.ts`)

`errorCopy(error: UiError): { text: string; action: 'retry' | 'repair' | 'details' | 'edit' | null }`:

| Kind or code                                                            | Text                                                | Action              |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| `timeout`, `unreachable`                                                | «El guardián no responde»                           | retry (+ «Reparar») |
| `not_installed`                                                         | «El guardián no está instalado»                     | repair              |
| `unauthorized`, `incompatible`                                          | «Actualiza el guardián»                             | repair              |
| `read_only`                                                             | «El guardián solo puede leer ahora mismo»           | details             |
| `extension_exceeds_max`                                                 | «Como mucho 24 h en total»                          | edit                |
| `block_not_active`                                                      | «El bloqueo ya terminó»                             | null                |
| `not_extendable`                                                        | «Un castigo no se puede ampliar»                    | null                |
| `duration_out_of_range`                                                 | «Entre 5 min y 24 h»                                | edit                |
| `too_many_targets`                                                      | «Demasiados bloqueos activos a la vez»              | edit                |
| `protected_target`                                                      | «Eso no se puede bloquear: el sistema lo necesita»  | edit                |
| `unknown_id`                                                            | «Actualiza el guardián: no conoce ese servicio»     | repair              |
| `phrase_mismatch`                                                       | «La frase no coincide»                              | edit                |
| `confirm_word_mismatch`                                                 | «Escribe BORRAR»                                    | edit                |
| `emergency_not_ready`                                                   | «Aún no: espera a que acabe la cuenta atrás»        | null                |
| `emergency_expired`                                                     | «Se pasó el plazo: pide la emergencia otra vez»     | null                |
| `emergency_in_progress`                                                 | «Ya hay una emergencia en marcha»                   | null                |
| `emergency_not_available`                                               | «Ese bloqueo no admite emergencia»                  | null                |
| `emergency_moot`                                                        | «Los bloqueos ya terminaron: no se ha cobrado nada» | null                |
| `data_delete_blocked`                                                   | «Ahora no se puede borrar» + reason                 | null                |
| `rate_limited`                                                          | «Demasiados intentos: espera un momento»            | retry               |
| anything else (`internal`, `invalid_response`, `confirmation_required`) | «Algo ha fallado en el guardián»                    | details             |

### 7.6 Section 2 «Bloqueo» (BLOQUEO)

One component per `bloqueoVariant`, and a pure `deriveBloqueoView` behind them.

| Variant      | Header                                                                  | Body                                                                                                                             |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `idle`       | «Bloqueo: ninguno» · «Próximo horario: 18:00»                           | See the list below the table                                                                                                     |
| `confirm`    | same, or the active header when the card sits over a block              | See the list below the table                                                                                                     |
| `pending`    | as `confirm`                                                            | Button reads «Bloqueando…» (disabled, no spinner)                                                                                |
| `failed`     | as `confirm`                                                            | Help line «El guardián no responde · Reintentar · Reparar» (or the `errorCopy` of a rejection); Esc sends `block:create-dismiss` |
| `active`     | «Bloqueo: YouTube, Instagram · Estricto» · «hasta 17:42» + «Nuevo» pill | See the list below the table                                                                                                     |
| `punishment` | «Castigo: todas las distracciones · 60 min»                             | Countdown, red bar, «3 strikes en "mates"» · «−100 puntos», no extend row, no reprimand                                          |
| `finished`   | «Bloqueo: terminado» · «Hecho. +80 puntos» (green, 1 min)               | Field + templates                                                                                                                |
| `boot-hold`  | active header                                                           | «Comprobando la hora…» in place of the countdown                                                                                 |

**`idle`.** Field (the example phrase rotates with `floor(now / 4000)`, so a frozen harness
clock gives a deterministic example). While typing, the help line shows chips from
`parseIntent` («YouTube · 1 h · hasta 18:00»; click a chip to correct it) or «No he entendido:
"mañana tarde"». Below: the templates «Deberes 1 h | Examen 3 h | Leer 30 min | Más…».

**`confirm`.** The card replaces the templates:

- chips of what is blocked;
- duration ⇄ end, kept in sync, 5 min to 24 h;
- the `radiogroup` Normal | Estricto | Hardcore | Examen, with help from `EMERGENCY_RULES` /
  `POINT_RULES`;
- «Tu motivo»;
- «Solo se puede ampliar, nunca acortar»;
- **Editar… | Bloquear hasta 17:42**.

The consequence step shows the red line and «Sí, bloquear 6 h», disabled for 2 s.

**`active`.** Top to bottom:

- the countdown and the 3 px mode bar;
- the reason in italics;
- **+15 min | +30 min | +1 h | Otro…**, then the undo line;
- the rows (at most 2), then «y N más…»;
- the emergency line.

**Study phrases while the `study` flag is off** («estudiar mates 1 hora»): the chips show what
was understood, the help line says the Study Mode is coming, and Enter opens Bloqueos with the
duration seeded. It never becomes a block silently.

### 7.7 Detail windows (DETAILS)

All three use the same section pattern. They may use two columns, and here content may
scroll.

**Bloqueos.**

- The advanced form:
  - catalog search and categories with checkboxes;
  - custom domains, validated with `normalizeDomain` / `isValidDomain`;
  - apps with autocomplete from `system:process-names`;
  - duration from 5 min to 24 h, or «Hasta las HH:MM»;
  - mode and «Tu motivo»;
  - **Guardar como plantilla | Bloquear…**.
- «Bloquear…» sends `window:confirm-draft`: the one confirmation path is the main window's
  card.
- Also shown: active blocks (from the snapshot), templates (save and delete), the schedules
  list with a switch per row (`schedules:set-enabled`), and exam mode with the whitelist.
- It opens seeded from `DetailRequest.seed` and scrolls to `focus`.

**Emergencia.**

- The preview, already priced: «Perderás 620 puntos y tu racha de 5 días».
- Hardcore and exam blocks are listed as staying.
- The phrase is typed by hand: paste is refused, and the guardian checks it again.
- Counting: «Esperando · 8:12 · Cancelar (recomendado)», in orange, from `state.emergency`.
- Ready: «Desbloquear», with the in-place «¿Seguro?», then the result.

**Ajustes.** Groups, each a set of 48 px rows:

- General: theme Sistema | Claro | Oscuro, and autostart.
- Bloqueo: default mode.
- Sistema: guardian status and version, «Reparar», extensions (connected, incognito, host
  permission), «Nuevo código» at 32 px with «Puerto: N» when not 47600, and «Copiar
  diagnóstico».
- Datos: «Borrar todos mis datos», enabled once BORRAR is typed.

Everything applies at once, with no «Guardar».

---

## 8. Windows (MAIN-WINDOW)

### 8.1 Bootstrap order (`src/main/index.ts`)

1. **Before `ready`:**
   - `requestSingleInstanceLock()`: if it fails, quit; otherwise `second-instance` calls
     `showMain`;
   - `app.setAppUserModelId(APP_ID)`;
   - `app.enableSandbox()`;
   - honour the harness arguments and environment only if `!app.isPackaged` (§10).
2. **`createCore(options)`.** Prefs are loaded synchronously inside it. Then
   `nativeTheme.themeSource = prefs.theme`.
3. **`whenReady`:**
   - session hardening (§11);
   - the tray, with the idle icon;
   - `createMainWindow()`, hidden;
   - `registerIpcHandlers(core, host)` and `registerWindowIpc(...)`;
   - `core.start()`;
   - wire `powerMonitor` `resume` / `unlock-screen` to `core.refreshNow('resume')`.
4. **Main `ready-to-show`:** show it unless launched with `--hidden` (or macOS login), then
   pre-warm the detail window after 1 s.
5. **`window-all-closed`** does nothing. **`before-quit`** sets `quitting = true` and awaits
   `core.shutdown(1500)`. Only «Salir», the tray «Salir» or Cmd+Q quit.

### 8.2 Main window

**Options:**

```ts
new BrowserWindow({
  width: 440,
  height: 540,
  useContentSize: true,
  show: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  autoHideMenuBar: true,
  title: 'Céntrate',
  paintWhenInitiallyHidden: true,
  backgroundColor: colors[resolveTheme(prefs.theme, nativeTheme.shouldUseDarkColors)].bg,
  webPreferences: {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  },
});
```

- `backgroundThrottling` keeps its default (`true`), for the CPU target.
- Windows and Linux: `win.setMenu(null)`. macOS: an app menu with only the app and Edit roles,
  or copy and paste break.
- `page-title-updated` is prevented: main owns the title.
- `close` is prevented unless quitting: it hides main and detail, and on the first time
  queues the close hint (§6.4) and sets `prefs.closeHintShown`.
- `render-process-gone`: recreate the window hidden and restore its visibility.
  `unresponsive`: reload.

**Toggle** (tray left click, second instance):

- Visible and (focused, or blurred less than 250 ms ago, which is the Windows tray-click
  blur): hide.
- Visible but covered: `show()` + `focus()` to bring it to the front.
- Otherwise run the **show path**, which has a 150 ms budget and no white flash:
  1. Compute placement: display, anchor, `maxContentHeight` (§8.4).
  2. Push `ui:prepare-show {seq, layout}` and wait up to 50 ms for `window:show-ack`; else use
     the last height.
  3. `setContentBounds(anchored rect)`, then `show()`, then `focus()`.
  4. Push `ui:visibility {visible: true, focused: true, focusField: true}`.
  5. `core.visibilityChanged()`, then `core.refreshNow('show')`.

Hidden windows still receive snapshots, so the handshake only measures.

### 8.3 Auto-height and density

- The renderer sends `window:layout {height, density, scroll}`.
- Main clamps it to `maxContentHeight = workArea.height − 2×10 − frame.top − frame.bottom`.
- It applies the height with `setContentBounds(rect, false)` and keeps the **anchored edge**
  fixed: `y = anchorBottom − frame.bottom − height` on Windows and Linux-bottom, `y`
  unchanged on macOS and Linux-top. Never use `setContentSize`, which grows the window
  downwards and off screen.
- All values are rounded to whole DIP.
- Frame insets are measured once per window as `getBounds()` minus `getContentBounds()`. Under
  xvfb (no window manager, insets 0) the fake display's `frame` is used instead.
- The detail window follows every height change.

Targets: at most 540 DIP of content at rest and 600 in any state. The e2e matrix checks
`scrollHeight <= clientHeight` for every state on every preset.

### 8.4 Positioning (pure `windows/geometry.ts`)

The main window sits 10 DIP from the edges of the tray display's work area, and returns there
on every show.

| OS      | Display                                                                                             | Corner and anchor                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows | `getDisplayMatching(tray.getBounds())`, falling back to the cursor display when the bounds are zero | Always bottom-right, whatever the taskbar edge; anchor `bottom`                                                                                                                |
| macOS   | The tray display                                                                                    | Top-right; anchor `top`                                                                                                                                                        |
| Linux   | `tray.getBounds()` is zeros, so `getDisplayNearestPoint(getCursorScreenPoint())`                    | Right corner on the panel side: `topInset = wa.y − b.y`, `bottomInset = b.bottom − wa.bottom`; anchor `top` when `topInset ≥ bottomInset` (also when both are 0, as in Ubuntu) |

- `screen` `display-metrics-changed`, `display-added` and `display-removed` recompute the
  placement, re-place a visible window and push `ui:layout`.
- In harness mode a fake display source replaces `screen`, from `DISPLAY_PRESETS` and
  `--harness-display`. `fixtures.layoutForDisplay` must equal `geometry.maxContentHeight`; a
  test checks it.
- The windows the fake display places still go on the real screen. When the primary display
  is smaller than the preset (the Windows CI runner has 1024×768 px), the fake display moves
  by whole device pixels so its anchored right corner lies on the real work area
  (`fake-display.ts`, `hostOffset`). A window that intersects no monitor gets no frame on
  Windows (Chromium's `WM_NCCALCSIZE`), so its content grows by the frame width until its size
  changes.

### 8.5 Detail window

- One `BrowserWindow`: content 600 DIP wide, `useContentSize`, not resizable, `skipTaskbar`,
  **no `parent`**. A parent means WM placement on Linux and sheet behaviour on macOS. It uses
  the same `webPreferences`.
- Pre-warmed hidden with `?window=detail`.
- On `window:open-detail`: push `ui:detail`, set the title («Bloqueos», «Emergencia»,
  «Ajustes»), place it, `show()` and `focus()`.
- **Placement:**
  - Outer height = main's outer height, at least 480 + frame, clamped to the work area.
  - Aligned on the main window's anchored edge.
  - Left of main with a 6 DIP gap; on the right if there is no room; otherwise pinned to
    `workArea.x`.
  - It follows main's height changes.
- Its X or Esc (`window:close-detail`) hides it. Hiding main hides it too. Only one detail
  view exists at a time.

### 8.6 Tray and title (pure `tray/model.ts` + controller)

**Icon.**

- Key `idle | normal | strict | red | study`, from the strongest active block:
  punishment/hardcore/exam > strict > normal. `study` and the camera dot come with the flag.
- PNGs at 16, 20, 24 and 32 px, mapped to scale factors 1, 1.25, 1.5 and 2.
- The idle icon is monochrome: light and dark variants on Windows, chosen by
  `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`; a template image on macOS.
- Colored icons also come in light and dark variants, using the theme's accent.
- `scripts/gen-tray-icons.mjs` draws them from the brand masters (never G-Helper's glyph,
  docs/brand.md): idle is `assets/brand/icon-mono.svg`, the other keys are a disc in the
  accent with the mark of `assets/brand/icon.svg` cut out. Colors come from `tokens.ts`; the
  files go to `resources/assets/tray/`, which is already packaged as `<resources>/assets`.
  Unpackaged, it resolves from `app.getAppPath()`. CI runs it with `--check`.

**Tooltip.** Refreshed once per minute and on every publish, only when the text changed:

- «Céntrate · YouTube · quedan 43 min · 1.240 pts»;
- «Céntrate · castigo · quedan 38 min · 1.095 pts»;
- «Céntrate · sin bloqueos · 1.240 pts»;
- «Céntrate · guardián detenido».

**Window title.** «Céntrate», «Céntrate · quedan 42 min» or «Céntrate · castigo 38 min»
(«· estudiando» comes with the flag). It uses `formatRemaining` and is updated by the same
single timer, set to the next ceiling-minute flip.

**Menu** (serialisable `TrayMenuItemModel[]`, rebuilt only when its JSON changed; on Linux
`setContextMenu` is called again every time):

- the status line, disabled: «Quedan 43 min · YouTube» / «Sin bloqueos» / «Guardián
  detenido»;
- «Ampliar ▸ +15 min / +30 min / +1 h», only with an extendable primary block;
- «Bloqueo rápido ▸» with the templates (shows main + `confirm-template`);
- (Study Mode ▸ and the Mini temporizador checkbox, with their flags);
- «Abrir Céntrate»;
- «Salir (los bloqueos siguen activos)».

**Clicks.**

- Windows: `click` toggles; the right click shows the context menu.
- macOS: `click` toggles; `right-click` calls `popUpContextMenu`. Never `setContextMenu`, or
  the left click opens the menu. `tray.setTitle('42 min')` is optional.
- Linux: the context menu only (AppIndicator sends no clicks), so it carries «Abrir
  Céntrate».

---

## 9. Feature flags (`src/shared/features.ts`)

`study`, `stats`, `rewards`, `achievements`, `miniTimer`, `osd`, `onboarding`, `pomodoro`,
`sounds`, `reminders` and `updater`. Phase 1 shipped them all `false` (`PHASE1_FEATURES`);
**Phase 5 ships every one `true` except `study`** (another wave integrates
`packages/study-ai`). The list below is what «every flag off» still means.

- Flags travel in `snapshot.features`. Code reads `featureEnabled(snapshot.features, name,
snapshot.health?.capabilities ?? null)`. `study` and `rewards` also need their guardian
  capability.
- With every flag off:
  - there is no Study section;
  - Progreso shows its header and goal bar only (each tile appears with its own flag);
  - the footer has **Ajustes… | Salir** (Mini temporizador joins with its flag);
  - the tray has no Study Mode ▸ and no Mini temporizador entry;
  - there is no OSD and no onboarding.
- Overrides (`resolveFeatures`) are honoured only in harness mode.

---

## 10. Harness (PROMPT §10 «Arnés de estados»)

**States** (`src/shared/fixtures.ts`). `HARNESS_NOW` is Monday 2026-09-28 17:00 Madrid time.
Main-window fixtures render on the 1920×1080 at 100 % preset unless noted. Detail fixtures
render the main window too.

| Id                   | Window     | What it shows                                                              | Variant      |
| -------------------- | ---------- | -------------------------------------------------------------------------- | ------------ |
| `idle`               | main       | «Bloqueo: ninguno» · «Próximo horario: 18:00», field, templates            | `idle`       |
| `typing`             | main       | «no veo YouTube en una hora» → chips                                       | `idle`       |
| `not-understood`     | main       | «no veo YouTube mañana tarde» → «No he entendido: "mañana tarde"»          | `idle`       |
| `confirm-normal`     | main       | Card, YouTube 1 h, Normal                                                  | `confirm`    |
| `confirm-over-4h`    | main       | Redes sociales 6 h, consequence line, button disabled                      | `confirm`    |
| `confirm-hardcore`   | main       | Juegos 1 h 30 min Hardcore, «No podrás cancelarlo…»                        | `confirm`    |
| `confirm-exam`       | main       | Template Examen 3 h, whitelist                                             | `confirm`    |
| `pending`            | main       | «Bloqueando…»                                                              | `pending`    |
| `guardian-timeout`   | main       | «El guardián no responde · Reintentar · Reparar»                           | `failed`     |
| `one-block`          | main       | «YouTube, Instagram · Estricto» · «hasta 17:42», 42:10                     | `active`     |
| `three-blocks`       | main       | Big countdown (2:10:05) + 2 rows                                           | `active`     |
| `extend-undo`        | main       | «+30 min · termina a las 18:12 · Deshacer (4 s)»                           | `active`     |
| `finished`           | main       | «Hecho. +80 puntos»                                                        | `finished`   |
| `emergency-waiting`  | emergencia | «Esperando · 8:12 · Cancelar (recomendado)»; main shows «Emergencia: 8:12» | `active`     |
| `emergency-ready`    | emergencia | «Desbloquear» armed                                                        | `active`     |
| `punishment`         | main       | Castigo, red bar, «3 strikes en "mates"», «−100 puntos»                    | `punishment` |
| `negative-points`    | main       | «Nivel 3 · −340 puntos», «Números rojos»                                   | `idle`       |
| `protection-broken`  | main       | Red «Guardián detenido…», footer «Guardián detenido · Reparar»             | `idle`       |
| `extension-missing`  | main       | Orange «Chrome no tiene la extensión…» over an active block                | `active`     |
| `compact-density`    | main       | Orange warning + 3 blocks + undo line at 1366×768 at 125 % → compact       | `active`     |
| `bloqueos`           | bloqueos   | Form, active blocks, templates, schedules                                  | `active`     |
| `emergencia`         | emergencia | Preview «Perderás 620 puntos y tu racha de 5 días», phrase half typed      | `active`     |
| `ajustes`            | ajustes    | All groups                                                                 | `idle`       |
| `hardcore-block`     | main       | «Hardcore: no se puede cancelar», red bar                                  | `active`     |
| `many-blocks`        | main       | 6 blocks → «y 3 más…»                                                      | `active`     |
| `boot-hold`          | main       | «Comprobando la hora…»                                                     | `boot-hold`  |
| `not-installed`      | main       | `state: null`, «Guardián no instalado…»                                    | `idle`       |
| `bloqueos-prefilled` | bloqueos   | Seeded with «YouTube» from the not-understood phrase                       | `idle`       |
| `ajustes-pairing`    | ajustes    | Code «482913» at 32 px                                                     | `idle`       |
| `ajustes-delete`     | ajustes    | «BORRAR» typed                                                             | `idle`       |

Phase 5 states (onboarding, mini timer, OSD, Nuclear, the new windows…) are listed in §15.5;
Study Mode states join with the study flag. `blocked.html` belongs to the extension owner.

**Electron harness.** Honoured only when `!app.isPackaged`:

```sh
electron out/main/index.js --harness-state=<id> [--harness-display=1366x768@125] [--harness-theme=dark] [--harness-show]
```

Main (MAIN-WINDOW parses the arguments):

- passes `harnessFixture(id)` to `createCore`, which seeds its store from `fixture.snapshot`
  and serves the rest from `FakeGuardianClient(fixture)`: `snapshot.state`, `fixture.fake`,
  scripted writes, a call recorder and events for notifications;
- freezes the clock at `nowMs`;
- sends `harnessLoad(fixture)` in `app:init`;
- installs `globalThis.__centrateHarness: HarnessApi` (see `contracts.ts`).

Playwright switches states in-process with `harness.load(id, {theme, display})`. It relaunches
only when the device scale factor changes, because `--force-device-scale-factor` is
process-wide. `load` resolves after every open window answered `window:ready` for that id.

**Browser harness** (dev only): run `npm run dev -w apps/desktop` and open the renderer URL
with `?window=main&state=<id>`. Without `window.centrate`, `getBridge()` serves the fixture
from memory. Invokes answer from `fixture.fake`; writes just log.

---

## 11. Security

- `app.enableSandbox()`; `contextIsolation`, `sandbox` and no `nodeIntegration` in every
  window.
- The preload exposes only `CentrateBridge`, never `ipcRenderer`.
- Every IPC message is checked for its sender frame (`WindowHost.windowOf`: the window registry
  plus the app URL, which is the `file://…/renderer/index.html` prefix or the dev server) and
  for its payload (`ipc-guards.ts`, plus `isCreateBlockRequest` for creates).
- The session:
  - denies every permission request and check (the camera window is a separate, later entry);
  - uses `setWindowOpenHandler(() => ({ action: 'deny' }))`;
  - prevents `will-navigate` and `will-attach-webview`.
- CSP: keep the `index.html` meta (`script-src 'self'`, `connect-src 'self'`). Renderers can
  never reach `127.0.0.1:47600`.
- Guardian HTTP runs only in main, through Node `fetch`. The token comes from
  `<sys>/client.json` and appears in no IPC payload or log line.
- `shell.openExternal` only for the fixed `GuideId` URLs.
- Harness arguments and environment overrides only when `!app.isPackaged`.

---

## 12. Test strategy

- **Vitest (`npm test -w apps/desktop`).** Node environment, `TZ=Europe/Madrid`, files in
  `test/**/*.test.ts(x)` (the e2e specs are excluded). Each owner tests its pure modules:

| Owner         | Must cover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LEAD          | Fixtures (contract validators, variants, determinism), draft helpers, `toUiError`, selectors, format (countdown drift 0 over an hour with late timers), IPC lists, flags                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| MAIN-WINDOW   | Geometry (every OS corner, anchored edge fixed when growing and shrinking, multi-display with negative coordinates, 1.25 and 1.5 rounding, detail left/right/clamp, Linux panel sides, parity with `layoutForDisplay`); tray model (icon key, tooltip, menu per fixture); title; toggle logic                                                                                                                                                                                                                                                                                                               |
| MAIN-GUARDIAN | Poller cadence (2 s visible, 60 s hidden, 304 publishes nothing, end + 300 ms); link rule (warning ≤ 5 s, no flapping); create (timeout → failed; retry reuses the key; `lastCreated` + insert in one publish); extend queue (nothing before 5 s, undo, coalescing, too late, retries keep the key, flush on quit; property test: minutes sent = minutes clicked and not undone); notification policy (≤ 1 per minute property test, grouping copy, backlog, focus suppression); event sync and DB on `:memory:` (atomic cursor, reset wipes, malformed stored); client.json (missing, rotated); IPC guards |
| RENDERER-CORE | `chooseLayout`, `errorCopy` for every code, the protection, progreso and footer view models per fixture, store `applySnapshot` (rev ordering, reconcile)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BLOQUEO       | `deriveBloqueoView` for every fixture (header, datum, help line, tiles, disabled reasons, «y N más…», undo line), Enter/Esc cascade reducer, chip editing                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DETAILS       | View models of the three windows per fixture, phrase gating, BORRAR gating, pairing expiry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- **Playwright (`npm run e2e -w apps/desktop`, HARNESS).** Build first with
  `npm run build -w apps/desktop`. Run under
  `xvfb-run -a -s "-screen 0 2880x1800x24"`; the default xvfb screen is 640×480×8.
  - Launch with `_electron.launch({ executablePath: electron, args: ['out/main/index.js', '--harness-state=…', '--force-device-scale-factor=…'], env: { TZ: 'Europe/Madrid', LANG: 'es_ES.UTF-8', CENTRATE_USER_DATA: tmp } })`.
    Add `--no-sandbox` when running as root, which this container does.
  - `smoke`: the window starts hidden; `showMain()` focuses the field in < 150 ms; the first
    captured frame has the theme `bg` (no white flash).
  - `flows` (fake guardian):
    - phrase + Enter + Enter → «Bloqueando…» → active; template + Enter;
    - more than 4 h, Hardcore and Examen need the second Enter after 2 s;
    - timeout → Reintentar with the same `Idempotency-Key` (`guardianCalls()`);
    - extend + Deshacer before 5 s → 0 calls; extend alone → 1 call at ≥ 5 s (`advance`);
    - tray template → card; X hides and the hint is sent once;
    - emergency preview → phrase (paste refused) → counting → `advance` → ready → armed
      confirm;
    - Ajustes: theme live, pairing code, «Copiar diagnóstico», BORRAR;
    - notifications through `harness.notifications()`.
  - `layout`: for every state × preset,
    - `scrollHeight <= clientHeight` on the main window;
    - no `[data-fit]` element with `scrollWidth > clientWidth + 1`;
    - the bounds sit 10 DIP from the fake work area on the anchored edge (10–13 DIP at 125 %
      and 10–11 at 150 %, where the edges move inward onto device pixels);
    - density equals `fixture.expect.density`;
    - at 1920×1080 at 100 %, content is ≤ 540 at rest and ≤ 600 in any state.
  - `a11y`: inject `axe-core` with `page.evaluate` and run `axe.run()` for every state in both
    themes, expecting 0 violations. Its normal mode opens a new page, which Electron does not
    allow.
  - `screenshots` (`npm run ui:capture`): every state × {light, dark} × the 4 presets, written
    to `docs/ui/<preset>/<theme>/<state>.png`, plus a generated `docs/ui/index.html` that shows
    them side by side with the G-Helper reference. Temporary captures go to the scratchpad.
  - `wire`: against a mock guardian (`node:http`, with `client.json` in a temporary
    `CENTRATE_DATA_DIR`):
    - main's `fetch` sends no `Origin` (closes the ARCHITECTURE §17 Electron 44 spike);
    - a rotated token recovers after a 401;
    - a 304 pushes nothing;
    - a stopped server shows section 1 within 5 s.
  - `perf` (nightly): CPU under 1 % while hidden for 60 s; countdown drift ≤ 1 s.

---

## 13. Decisions to record (DECISIONS.md, Spanish, coordinator)

1. The extend queue adds up clicks on the same block inside the 5 s window and **sends**
   waiting extensions on «Salir».
2. Notifications are not shown while the main window is visible and focused.
3. The first X shows a one-time native notification: «Céntrate sigue en la bandeja. Los
   bloqueos siguen activos.»
4. The tray «Ampliar ▸» shows the main window, so the 5 s undo is visible (the OSD is off in
   Phase 1).
5. «Borrar todos mis datos» wipes the local events, the custom templates and the last reason.
   It keeps the theme, autostart and default mode.
6. One renderer bundle for every UI window. The camera window will be separate.
7. «Hecho. +80 puntos» lasts 60 s. `GET /v1/points` is not polled.
8. The Bloqueos «Bloquear…» button hands the draft to the main window's card, the one
   confirmation path.
9. A study phrase with Study Mode off opens Bloqueos with the duration and never becomes a
   block silently.
10. The countdown rounds **up** to the second, and minute phrases round up («quedan 43 min»
    while the countdown reads 42:10).
11. «Arranque automático» is on by default (the tray keeps the remaining time and the
    notifications); Ajustes turns it off.

---

## 14. Open issues for other owners

- **Coordinator, dependencies.** Declare devDependencies in `apps/desktop/package.json` and
  update the lockfile: `@playwright/test` (^1.63, already hoisted from `apps/web`) and
  `axe-core` (^4.13, hoisted). No runtime dependency is added.
- **Coordinator, CI.**
  - xvfb with `-s "-screen 0 2880x1800x24"`;
  - `TZ=Europe/Madrid`, `LANG=es_ES.UTF-8` and `fonts-noto-core` for stable screenshots;
  - upload `docs/ui` as an artifact.
- **Coordinator, ESLint (optional).** Add `no-restricted-imports` of `electron` in
  `apps/desktop/src/{shared,renderer}/**`, and of `node:*` in `src/renderer/**`.
- **Lead, optional.** `renderer.build.minify: true` in `electron.vite.config.ts`: the bundle is
  unminified today (641 KB for an empty app).
- **Linux Wayland.** Native Wayland ignores window positions and cursor queries. Decide whether
  to force XWayland (`app.commandLine.appendSwitch('ozone-platform', 'x11')` when
  `XDG_SESSION_TYPE=wayland` and `DISPLAY` is set) and record it in DECISIONS.
- **macOS packaging (electron-builder owner).** `LSUIElement: true` (menu-bar app; hide the
  Dock icon), with the app menu keeping the Edit roles.
- **Installer and guardian owners.**
  - Exact elevated commands for «Reparar» on each OS (`centrate-guardian start`, or `install`
    then `start`).
  - A `testhooks` guardian that honours `CENTRATE_DATA_DIR` without root, for real-binary e2e.
  - Confirm that the `/v1/state` ETag is stable when nothing changes, so the 2 s poll returns
    304s.
- **Catalog owner.** Services have a `monogram`, not the «favicon guardado en el catálogo» the
  brief mentions. Phase 1 chips use the monogram.
- **Extension owner.** The guide URLs for `extension-chromium`, `extension-firefox` and
  `extension-incognito` (the web or GitHub pages `app:open-guide` opens).

---

## 15. Phase 5 contract

Everything the Phase 5 builders compile against. The lead owns every file named in the table
at the top of this document; builders never edit them (a change they need goes in their
report). Brief: PROMPT §5 («Mini temporizador», «Ventana activa»), §7 (rewards, achievements,
mascot), §9 and §10 (Estadísticas, Recompensas, Logros, Ajustes, OSD, mini timer, Nuclear,
onboarding). Guardian endpoints: ARCHITECTURE §8.7–8.8.

Principles that do not change: main owns every timer that matters and every piece of state;
renderers draw one `UiState`; fallible invokes answer `CommandResult` and never throw; flags
hide, never grey out; colors only from tokens; every string in both `i18n/es.ts` and
`i18n/en.ts` of its area.

### 15.1 Ownership

| Owner        | Paths (only these)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PLATFORM** | `src/main/{activewin,updater,reminders,shortcuts}/**`, `src/main/windows/{mini-timer,osd,nuclear}*.ts` and their registration (`app/bootstrap.ts`, `windows/shell.ts` registry + `windowOf`/`initPayload`, `app/harness.ts` `openSurface` and surface `load`, the Phase 5 entries of `windows/ipc-window.ts`), new handlers in `ipc-handlers.ts` and `guardian/core.ts` (override the stubs), `src/main/guardian/**` (MockGuardian rewards and Nuclear heartbeat, fake guardian seed), `src/main/db/stats*.ts`; **lead additions**: `src/main/tray/**` for the «Mini temporizador» checkbox and the OSD after tray actions, onboarding centring in `windows/geometry.ts` + `shell.ts`, `src/main/app/shortcuts.ts` | `PlatformServices` (`contracts.ts`), every Phase 5 invoke handler, the send channels, `Core.patchSnapshot` publishers (`progress`, `updater` + `app.updateVersion`, `activeWindow`, `shortcuts`, `osd`, `nuclear`), stats from the events DB (schema v2 tables), CSV save dialog, `sounds:load` from `resources/sounds/`, koffi FFI for the active window, electron-updater, Nuclear heartbeat every 3 s. Tests: `test/main/{activewin,updater,reminders,shortcuts,platform,db}/**` |
| **STATS**    | `src/renderer/src/windows/estadisticas/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | «Día \| Semana \| Mes», bars (Recharts, lazy, one color, baseline only), GitHub heatmap in green, top targets, best hours, event log with filters, «Exportar CSV», text summary beside each chart, empty state. Tests: `test/renderer/estadisticas/**`                                                                                                                                                                                                                              |
| **REWARDS**  | `src/renderer/src/windows/{recompensas,logros}/**`, `src/renderer/src/sections/progreso/**`, `src/renderer/src/components/mascot/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shop rows with in-place «¿Seguro?» (armed id `redeem:<offerId>`), «Te faltan 40 puntos», the mascot in large; Logros 4-column grid (help line = how to get it); Progreso header mascot from `snapshot.progress` and its three 40 px doors (fit + mnemonics). Tests: `test/renderer/{recompensas,logros,progreso}/**` and the Progreso cases of `test/renderer/core/views.test.ts`                                                                                                   |
| **PLANNER**  | `src/renderer/src/windows/bloqueos/**`, `src/renderer/src/features/{pomodoro,sounds}/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Schedules create / edit / delete / toggle (guards `schedule_in_progress`, `schedule_starting_soon`), exam mode and its whitelist (`settings:put` of `studyWhitelist`, pending additions shown with `effectiveAt`), Pomodoro presets and the custom one, the sound player (`MainWindowFeature`). Tests: `test/renderer/{windows,features}/**` for its files                                                                                                                          |
| **SETUP**    | `src/renderer/src/windows/{ajustes,onboarding}/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Ajustes complete (General: idioma, tema, arranque, objetivo diario, sonidos, avisos grandes, atajo global; Bloqueo: modo, penalizaciones, cerrar navegadores; Sistema: guardián, extensión, ventana activa, actualizaciones, diagnóstico; Datos: exportar, borrar) with pending weakening changes; onboarding's 5 steps. Tests: `test/renderer/{ajustes,onboarding}/**`                                                                                                             |
| **SURFACES** | `src/renderer/src/windows/{mini-timer,osd,nuclear}/**`; **lead addition**: `src/renderer/src/sections/footer/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Mini timer 180×44 (service icon, time at 20 px, drag region), OSD pill (black 60 %, 28 px/600, radius 8), Nuclear (theme bg, 72 px countdown, «Castigo · vuelves a las 18:40», one «Salida de emergencia»); footer «Mini temporizador» → `mini-timer:toggle`, «Actualizar a vX» → updater. Tests: `test/renderer/surfaces/**`, footer cases of `views.test.ts`                                                                                                                      |

- e2e: each owner adds its own `e2e/<area>.spec.ts`; `e2e/support/**` and the matrix specs
  stay HARNESS's (report what you need). Surface fixtures open no detail window
  (`fixture.detailRequest === null`); their own window joins the matrix once PLATFORM
  implements `harness.openSurface`.
- Strings: a new area gets `i18n/es.ts` + `i18n/en.ts` exporting `X_ES` / `X_EN` (English
  typed `Widen<typeof X_ES>`); `test/shared/i18n-parity.test.ts` finds every `i18n/` folder by
  itself and checks key parity. Detail-window titles for the three new views are already in
  `src/main/windows/i18n` and `src/renderer/src/i18n`.
- Lead glue already done in other owners' files (so builders never touch shared shells):
  `renderer/src/app/{slots,route,Root,MainWindow,SurfaceWindow,memory-bridge}`, `store/{context,reducers}.ts`,
  `windows/bloqueos/index.tsx` (focus `exam`), `main/{ipc-guards,db/prefs-store,guardian/core,app/harness}.ts`,
  `main/windows/{ipc-window,send-guards,i18n/*}.ts`, the e2e window selection and the tests
  whose exhaustive tables list channels or states.

### 15.2 Renderer entry points (`src/renderer/src/app/slots.ts`)

| Module                                                | Export                                        | Mounted by                                                                                         |
| ----------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `windows/{estadisticas,recompensas,logros}/index.tsx` | default component, no props                   | the detail window (lazy, prefetched), like Phase 1 views                                           |
| `windows/{mini-timer,osd,nuclear}/index.tsx`          | default component, no props                   | `SurfaceWindow` for `?window=mini-timer\|osd\|nuclear` (the whole window, lazy)                    |
| `windows/onboarding/index.tsx`                        | default component, no props                   | the main window, **in place of its sections** while `onboardingActive(snapshot)`; the footer stays |
| `features/<name>/index.ts(x)`                         | `MainWindowFeature` (renders nothing visible) | the main window, once (sound player, Pomodoro clock); every window loads the module                |

A missing module renders a stand-in (or nothing), so parallel work never breaks the build.
The detail view's own readiness probe runs after it (`ReadyProbe`); surfaces report
`window:ready` the same way (PLATFORM routes it to its windows).

### 15.3 IPC (Phase 5 channels in `src/shared/ipc.ts`)

Invoke (all `CommandResult`; validators in `src/shared/ipc-payloads.ts`, spread into
`src/main/ipc-guards.ts`):

| Channel                                  | Request → result                                                   | Guardian / source                              | Callers                  |
| ---------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- | ------------------------ |
| `schedules:create`                       | `{intentId, input: ScheduleInput}` → `Schedule`                    | POST /v1/schedules (I)                         | PLANNER                  |
| `schedules:update`                       | `{id, input}` → `Schedule`                                         | PUT /v1/schedules/{id}                         | PLANNER                  |
| `schedules:delete`                       | `{id}` → `null`                                                    | DELETE /v1/schedules/{id}                      | PLANNER                  |
| (`schedules:set-enabled`)                | Phase 1 toggle, unchanged                                          | PUT                                            | PLANNER                  |
| `settings:get`                           | `null` → `SettingsResponse` (`settings` + `pending`)               | GET /v1/settings                               | SETUP, PLANNER           |
| `settings:put`                           | `{settings: GuardianSettings}` (full) → `SettingsResponse`         | PUT /v1/settings (weakening → `pending`, 24 h) | SETUP, PLANNER           |
| `rewards:list`                           | `null` → `RewardsResponse`                                         | GET /v1/rewards                                | REWARDS                  |
| `rewards:redeem`                         | `{intentId, offerId}` → `RedeemRewardResponse`                     | POST /v1/rewards/redeem (I)                    | REWARDS                  |
| `points:summary`                         | `null` → `PointsSummary`                                           | GET /v1/points                                 | REWARDS                  |
| `achievements:list`                      | `null` → `AchievementStatus[]`                                     | local event log                                | REWARDS                  |
| `stats:overview`                         | `StatsQuery {range, anchor}` → `StatsOverview`                     | local event log                                | STATS                    |
| `stats:heatmap`                          | `{end, weeks ≤ 53}` → `StatsHeatmap`                               | local event log                                | STATS                    |
| `stats:events`                           | `{filter, before, limit ≤ 200}` → `EventLogPage`                   | local event log                                | STATS                    |
| `stats:export-csv`                       | `{kind: 'events' \| 'days'}` → `CsvExportResult` (file name only)  | save dialog in main                            | STATS, SETUP             |
| `system:processes`                       | `null` → `RunningProcess[]` (`{name, appId}`)                      | OS                                             | PLANNER                  |
| `activewin:request-permission`           | `null` → `{outcome}`                                               | macOS Screen Recording                         | SETUP                    |
| `updater:check` / `download` / `install` | `null` → `UpdaterState`                                            | electron-updater                               | SETUP, SURFACES (footer) |
| `sounds:load`                            | `{sound: SoundId}` → `{bytes: Uint8Array, mime}`                   | `resources/sounds/` (`SOUND_FILES`)            | PLANNER                  |
| `onboarding:install-guardian`            | `null` → `{outcome: InstallOutcome}`                               | same path as «Reparar»                         | SETUP                    |
| `onboarding:test-camera`                 | `null` → `{outcome: 'unavailable'}` (placeholder until Study Mode) | —                                              | SETUP                    |

Send (validators `PHASE5_SEND_GUARDS`, spread into `windows/send-guards.ts`; PLATFORM handles):
`mini-timer:toggle {visible: boolean | null}` (null toggles), `mini-timer:position {position:
{x,y} | null}` (null = default corner; drags persist in main from `moved`), `osd:show
OsdRequest {text ≤ 80, icon, tone}` (shown only when «Avisos grandes» is on), and
`nuclear:emergency-exit null` (open Emergencia above the overlay).

Push: **no new channel.** Everything new travels in the snapshot, so fixtures can set it.
`DetailRequest` gains `{name: 'estadisticas', range}`, `{name: 'recompensas'}`, `{name:
'logros', focus}` and Bloqueos `focus: 'exam'` (`defaultDetailRequest(name)` builds a door's
request).

Windows: `WindowKind` stays `main | detail` (the shell's); `SurfaceKind = mini-timer | osd |
nuclear`; `UiWindow` (their union) is what `app:init`, `RenderEnv.window`, `IpcContext` and
`WindowHost` use.

### 15.4 State

**`UiSnapshot` additions** (`platform.ts`, initial values from `initialPlatformState()`; main
publishes them with `Core.patchSnapshot(patch)`, which bumps `rev` only on a real change):

| Field          | Type                                                    | Shown by                                                                     |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `progress`     | `{mascot, achieved, total, fresh} \| null`              | Progreso icon, Logros door datum                                             |
| `updater`      | `UpdaterState` (+ `app.updateVersion`)                  | footer, Ajustes › Sistema                                                    |
| `activeWindow` | `{status, lastMatch}`                                   | Ajustes › Sistema (permission row)                                           |
| `shortcuts`    | `{failed: ShortcutAction[]}`                            | Ajustes › General                                                            |
| `osd`          | `OsdMessage \| null` (cleared after `UI_TIMINGS.osdMs`) | the OSD window                                                               |
| `nuclear`      | `{overlay, displays, lastHeartbeatAt}`                  | the Nuclear window (with `nuclearPunishment` / `nuclearEndsAt` from `state`) |

**`UiPrefs` additions** (`prefs.ts`, `FeaturePrefs`; `prefs:set` patches merge nested objects;
`prefs-store` sanitizes field by field): `osd`, `sounds {ambient, volume, autoplay}`,
`reminders {schedules, leadMinutes, eyeBreaks}`, `shortcuts {toggle-main, extend-15,
toggle-mini-timer}` (Electron accelerators, `isAccelerator`), `miniTimer {visible, position}`,
`pomodoro {workMinutes, breakMinutes, cycles}`, `onboarding {done, step}`. Onboarding
navigation, «Omitir» and «Terminar» are `prefs:set { onboarding }`; step 5 writes «no veo
YouTube en 25 minutos» into `main.composer` itself (same renderer).

**Local state additions** (fixture-settable): `main.onboarding {pairing, installing}`;
`detail.estadisticas {range, anchor, eventFilter, exported}`; `detail.recompensas
{redeemed}`; `detail.bloqueos.schedule {id, input, error} | null` and `detail.bloqueos.exam
{domainInput, processInput}`; `detail.ajustes.capturing` (shortcut being recorded).

**Selectors**: `snapshotFeature`, `onboardingActive`, `onboardingStepNumber`,
`onboardingStepStatus`, `nuclearPunishment`, `nuclearEndsAt`; helpers `applyUiPrefsPatch`,
`clonePrefs`, stats `statsPeriod`, `shiftAnchor`, `heatmapLevel`, `bestHours`, `csvLine`.

### 15.5 Harness states (Phase 5)

`fixture.fake` gains `rewards`; the new `fixture.local` (`FakeLocalData`) holds what the app
answers from its own data: `stats {overview per range, heatmap (53 weeks), events}`,
`achievements`, `processes`, `updateCheck`, `installGuardian`.

| Id                     | Window       | What it shows                                                                                                    |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `stats-empty`          | estadisticas | First run: every period empty, heatmap all 0                                                                     |
| `stats-week`           | estadisticas | Week of 21–27 Sep (`anchor`), bars, top targets, best hours, 12-row log                                          |
| `rewards`              | recompensas  | 1.240 points, YouTube/Instagram offers available, the rest «not blocked»                                         |
| `rewards-short-points` | recompensas  | 110 points: «Te faltan 40 puntos» (help on `youtube-15`)                                                         |
| `logros`               | logros       | 3 of 8 reached; help line on `streak-30` («12 de 30»)                                                            |
| `onboarding-1` … `-5`  | main         | Welcome; guardian «No instalado»; extension with code 482913; camera placeholder; «no veo YouTube en 25 minutos» |
| `mini-timer`           | mini-timer   | One block (42:10), prefs visible at (1720, 24)                                                                   |
| `osd`                  | osd          | «+15 min · hasta las 17:57» (waiting +15 in the queue)                                                           |
| `nuclear`              | nuclear      | Nuclear punishment until 18:40, overlay shown                                                                    |
| `ajustes-full`         | ajustes      | Pending «objetivo 45 min» and «penalizaciones off»; update 0.2.0 available; `extend-15` refused                  |
| `schedules`            | bloqueos     | `focus: 'schedules'`, new schedule «L–V 16:00–19:00 · Redes sociales» open                                       |
| `exam-whitelist`       | bloqueos     | `focus: 'exam'`, extras + pending addition `geogebra.org`                                                        |
| `update-available`     | main         | Footer «Actualizar a v0.2.0» (updater `ready`)                                                                   |

Every other fixture has `prefs.onboarding.done = true`. `expect.warning` stays what section 1
would say (the onboarding hides the sections: `onboarding-2` is `'guardian'`).

### 15.6 Stubs until PLATFORM lands

`phase5InvokeStubs(currentFixture, now)` (`src/shared/phase5-stubs.ts`) is spread first in the
core's handler table and in the browser harness: with a harness fixture it answers reads
from `fixture.fake` / `fixture.local` and simulates writes (nothing persists); in a real run
every channel answers `internal / not_implemented / 501` (the renderer shows `errorCopy`'s
«Algo ha fallado en el guardián» with «Detalles»), except the camera test (`unavailable`).
`sounds:load` is `not_implemented` everywhere until PLATFORM reads the files. The send
channels are ignored (`phase5SendStubs`). `harness.openSurface` rejects until PLATFORM
registers the surface windows. PLATFORM overrides channel by channel by adding real entries
after the spread in `guardian/core.ts`; harness mode keeps answering stats, achievements,
processes and updater from `fixture.local` (guardian-backed channels should go through the
`FakeGuardianClient`, seeded from `fixture.fake`).

### 15.7 Rules and gotchas

- Real runs start with `prefs.onboarding.done = false`: the onboarding shows until finished or
  skipped (also for users upgrading from Phase 1). e2e runs without a harness state (the wire
  spec) must write a `prefs.json` with `onboarding.done: true` or go through «Omitir» once
  SETUP's module exists.
- `settings:put` always sends the **full** settings (read with `settings:get` first); weakening
  changes come back in `pending` with an `effectiveAt` estimate; setting the effective value
  again cancels one. Punishment changes apply at once.
- Rewards: never redeemable during Hardcore, Examen, punishments, Study Mode or a pending
  emergency (`lockReason`); custom domains never. The guardian re-checks everything.
- Stats never expose raw event data (reasons, tasks stay in main); the CSV path never crosses
  IPC.
- The OSD and the Nuclear overlay never take focus; the mini timer uses
  `-webkit-app-region: drag` and main persists `moved`.
- Brand assets: mascot (`assets/mascot/index.ts`: `mascotStyle(stage, size)`), achievement
  badges (`assets/achievements/index.ts`: `achievementBadgeStyle(id, achieved)`), sounds
  (`resources/sounds/*.wav`, `SOUND_FILES`), app icons (`build/`) are in place; paint the SVGs
  through the CSS mask helpers, never `<img>`.

### 15.8 State at hand-off

- Green: typecheck (node, web, e2e), ESLint, `lint:tokens`, 1 046 vitest tests, build.
- e2e: with the flags on, every main-window fixture reports two clipped labels
  («Recompensas…» by 3 px in the Progreso doors, «Mini temporizador» by 12 px in the footer)
  and the three doors without `aria-keyshortcuts` (keyboard audit, selfcheck). REWARDS
  (doors) and SURFACES (footer) fix them. The right/bottom inset checks at 125 % and 150 %
  fail by 1 DIP in this container at `HEAD` too (not a Phase 5 change).
