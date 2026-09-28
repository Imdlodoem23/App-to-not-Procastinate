# Céntrate cloud API (`apps/api`)

The engineering contract for Phase 6 (PROMPT §14): accounts, stats sync, friends, weekly
ranking, «estudiar juntos», accountability partners and the Claude coach. It merges the two
design proposals (privacy-first minimal backend, product-first) into one plan for four builders.

**Sources of truth.** Wire types, limits and the day/week helpers live in
`packages/shared/src/cloud-api.ts`; the database is `apps/api/src/db/schema.ts`; configuration
is `apps/api/src/config.ts`. When this document and the code disagree, the code wins and this
document gets fixed.

Contents:

1. Principles
2. Configuration and capabilities
3. Layout and ownership
4. Authentication
5. Endpoints
6. Database
7. Sync model
8. Friends, ranking and presence
9. Accountability partner
10. Coach (Claude API)
11. Web pages
12. Rate and size limits
13. Privacy, logging and GDPR
14. Desktop client contract
15. Deploying on Render
16. Testing
17. Work plan per builder
18. Decisions and rejected alternatives

---

## 1. Principles

- **The cloud is an optional mirror.** The desktop app and the guardian work 100 % without
  it, without an account and without internet (PROMPT §1). The guardian's event log stays the
  source of truth; every machine can rebuild its cloud copy from its own history.
- **The cloud never controls the machine.** No endpoint touches the guardian, and the server
  never sends commands. Nothing in the API can start, extend or end a block. An accountability
  denial only makes the app cancel its _own emergency request_ through the guardian's existing
  cancel endpoint, which keeps the block. The guardian gains no network dependency.
- **Everything is off by default.** Each feature is off until its environment variables are
  set (server side) and until the user turns its switch on (per user, `CloudSharing`). Friends
  see only what the user shares, and only if the user shares the same thing back
  (reciprocity).
- **Numbers, not content.** What leaves the machine is numeric daily totals, presence (state and
  times) and minimal accountability events (kind and time). Never domains, services, block
  reasons, tasks, window titles or emergency phrases. Coach text goes to Anthropic only when the
  user asks for coach help, and is never stored.
- **Only the desktop main process talks to the API.** The renderer and the extension never do;
  the bearer token lives in Electron `safeStorage`.
- **Free tier reality.** The Render web service sleeps and the free Postgres expires (§15). The
  app treats every call as optional: short timeouts, an offline outbox, and a full re-upload
  when the database is replaced.

## 2. Configuration and capabilities

Configuration comes only from environment variables, parsed once by `loadConfig()` with zod.
Nothing else reads `process.env`. `apps/api/.env.example` documents every variable.

| Variable                                                           | Default            | Effect                                                                |
| ------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `NODE_ENV`                                                         | `development`      | `production` requires `https` in `BETTER_AUTH_URL` and secure cookies |
| `HOST`, `PORT`                                                     | `0.0.0.0`, `3000`  | Render sets `PORT`                                                    |
| `LOG_LEVEL`                                                        | `info`             | pino level                                                            |
| `TRUST_PROXY_HOPS`                                                 | `0`                | Proxy hops to trust for the client IP. Render: `1`                    |
| `DATABASE_URL`                                                     | unset              | Postgres. Without it only `/health` works                             |
| `BETTER_AUTH_SECRET`                                               | unset              | ≥ 32 chars. Needed for accounts                                       |
| `BETTER_AUTH_URL`                                                  | unset              | Public API URL. Needed for accounts, OAuth callback, links            |
| `APP_ORIGINS`                                                      | empty              | CORS allow-list (comma-separated origins). Empty = closed             |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`                        | unset              | Google sign-in                                                        |
| `RESEND_API_KEY` + `EMAIL_FROM`                                    | unset              | Email sign-in codes and partner emails                                |
| `ANTHROPIC_API_KEY`                                                | unset              | Coach and phrase interpretation                                       |
| `AI_ENABLED`                                                       | `true`             | Global kill switch for the coach                                      |
| `AI_MODEL_INTERPRET`                                               | `claude-haiku-4-5` | Fast cheap model for phrases the local parser failed on               |
| `AI_MODEL_COACH`                                                   | `claude-opus-5`    | Capable model for the coach                                           |
| `AI_USER_DAILY_INTERPRET_REQUESTS`, `AI_USER_DAILY_COACH_REQUESTS` | `30`, `10`         | Per user per UTC day                                                  |
| `AI_USER_DAILY_TOKENS`                                             | `150000`           | Input + output tokens per user per UTC day, all AI features           |
| `AI_GLOBAL_DAILY_BUDGET_USD`                                       | `2`                | Global spend cap per UTC day; `0` turns the coach off                 |

Rules (`config.ts`):

- **Missing** keys switch their feature off; the process still starts. Empty strings count as
  missing (Render and `.env` files often carry `KEY=`).
- **Malformed** values (a short secret, a non-Postgres URL, an origin with a path, `http` in
  production) stop the process at boot with `ConfigError`, which names the variables and never
  echoes their values. `node dist/server.mjs --check` validates the environment and exits.
- **Half a pair** (Google id without secret, Resend key without `EMAIL_FROM`) counts as missing
  and is logged once as a warning.

### Capabilities

`deriveCapabilities(config, runtime)` computes `CloudCapabilities`, one entry per feature,
`{ enabled, reason }` with `reason ∈ missing_key | kill_switch | budget | database_down`:

| Feature          | Needs                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| `accounts`       | database + `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` + at least one sign-in method |
| `googleLogin`    | `accounts` + Google pair                                                          |
| `emailLogin`     | `accounts` + Resend pair                                                          |
| `sync`, `social` | `accounts`                                                                        |
| `partnerEmails`  | `accounts` + Resend pair                                                          |
| `coach`          | `accounts` + `ANTHROPIC_API_KEY` + `AI_ENABLED` + global budget left today        |

`GET /health` reports them with the live database state and budget. A disabled feature answers
`503 { error: { code: 'feature_disabled', feature, reason } }`. Without a database (or with
accounts off) every `/v1` route answers 503 `feature_disabled` for `accounts`; a database that
stops answering at runtime surfaces as 503 `database_unavailable`.

## 3. Layout and ownership

```text
apps/api/
  build.mjs              esbuild: src/server.ts → dist/server.mjs            (architect)
  drizzle.config.ts      drizzle-kit (npm run db:generate -w apps/api)       (architect)
  drizzle/               SQL migrations, applied at boot and in tests        (architect)
  .env.example                                                               (architect)
  src/
    server.ts            process entry: config, pool, migrations, janitor    CORE
    app.ts               buildApp(): helmet, cors, rate limit, sessions,
                         error envelope, minimal logs, route registration    architect (shared)
    config.ts            env parsing, capabilities                           architect (shared)
    context.ts           AppContext, AuthedUser, Mailer, fastify typings     architect (shared)
    db/schema.ts         Drizzle schema (all tables)                          architect (shared)
    db/client.ts         node-postgres handle, Db type, ping                  CORE
    db/migrate.ts        migrations under an advisory lock                    CORE
    db/meta.ts           server_epoch                                         CORE
    lib/errors.ts        ApiError + helpers                                   architect (shared)
    lib/guards.ts        requireUser/Db/Feature/FreshSession, zod parsing     architect (shared)
    lib/profile.ts       getProfile, requireConsent, requireDisplayName       CORE (shared use)
    lib/mailer.ts        Resend via fetch                                     CORE
    auth/                better-auth instance, resolveSession, /api/auth/*    CORE
    routes/health.ts     GET /health                                          architect
    routes/app-auth.ts   desktop loopback login                               CORE
    routes/me.ts         account, consent, devices, export, delete            CORE
    routes/sync.ts       sync and stats                                       CORE
    routes/friends.ts    invites, friends, blocks                             SOCIAL
    routes/ranking.ts    weekly ranking                                       SOCIAL
    routes/presence.ts   «estudiando ahora»                                   SOCIAL
    routes/accountability.ts  partners, events, approvals, inbox              SOCIAL
    routes/coach.ts      coach endpoints                                      COACH
    coach/               model seam, Anthropic client, prompts, schemas,
                         quota, budget                                        COACH
    pages/layout.ts      HTML shell, escaping, asset registry                 CORE (shared use)
    pages/account.ts     /cuenta, /cuenta/codigo, /cuenta/conectar, assets    CORE
    pages/panel.ts       /cuenta/panel, /cuenta/avisos                        CLIENT
    pages/social.ts      /i/:code                                             SOCIAL
    jobs/janitor.ts      retention sweep                                      CORE
  test/
    helpers/db.ts        PGlite + real migrations                             architect
    helpers/app.ts       test config, fake clock/mailer, test users, token
                         session resolver                                     architect
packages/shared/src/cloud-api.ts
                         wire types, limits, day/ISO-week helpers             architect
                         + typed client and offline outbox (end of file)      CLIENT
render.yaml              web service + Postgres appended                      CLIENT
```

**Build.** Node cannot run the sources directly: `@centrate/shared` uses extensionless imports
that Node's ESM loader rejects, so `--experimental-strip-types` is not an option.
`build.mjs` bundles `src/server.ts` with esbuild into `dist/server.mjs` (workspace code bundled,
npm packages external). Scripts: `build`, `start` (`node dist/server.mjs`), `dev`,
`db:generate`, `typecheck`, `test`. Vitest runs the TypeScript directly.

**Imports** inside `apps/api` are extensionless (esbuild and Vitest resolve them). Use
`import type` for types (`verbatimModuleSyntax`).

## 4. Authentication

### 4.1 better-auth setup (CORE, `src/auth/`)

- `betterAuth({ database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }), … })`,
  mounted at `/api/auth/*` through a Fastify route that builds a `Request` and returns
  `auth.handler(request)`.
- **Sign-in methods**, each only when configured:
  - **Google** (`socialProviders.google`), scopes `openid email profile`, no offline access, so
    no refresh token. `encryptOAuthTokens: true`.
  - **Email one-time code** (`emailOTP` plugin, `type: 'sign-in'`, 6 digits, valid 10 min,
    5 attempts). The email carries the code _and_ a link
    `{BETTER_AUTH_URL}/cuenta/codigo#email=…&otp=…`: the fragment never reaches the server, and
    the page signs in only after a click (link scanners cannot burn the code). This is the
    «enlace mágico» of PROMPT §14 without its trap: when the email is read on a phone, the user
    can still type the code in the computer's browser, which the desktop login needs.
  - No passwords.
- `bearer()` plugin: the desktop app sends `Authorization: Bearer <session token>`.
- Accounts with the same verified email are linked (`accountLinking.trustedProviders`).
- **Sessions**: 60 days, sliding (`updateAge` 1 day), no cookie cache (revocation is
  immediate). Cookies `HttpOnly; Secure (production); SameSite=Lax`, first-party on the API
  domain. `trustedOrigins = [BETTER_AUTH_URL, …APP_ORIGINS]`.
- **Privacy**: `telemetry: { enabled: false }`, `advanced.ipAddress.disableIpTracking: true`,
  user agents not stored (session `create.before` hook), the Google picture not stored
  (`image` always null).
- `databaseHooks.user.create.after` inserts the `profiles` row: every switch off, `displayName`
  = first word of the Google name, or null for email sign-ups.
- `createAuth(ctx)` returns `{ resolveSession, routes }`. `resolveSession(headers)` returns
  `AuthedUser { userId, sessionId, sessionCreatedAt, deviceId }` (device = the `devices` row
  whose `session_id` is this session) or null.
- **CSRF**: besides `SameSite=Lax`, a state-changing request (not GET/HEAD) authenticated by
  **cookie** must carry an `Origin` equal to the API origin or one in `APP_ORIGINS`, else 403
  `forbidden`. Bearer requests are exempt (not ambient credentials).

### 4.2 Desktop login: loopback redirect + PKCE (RFC 8252, RFC 7636)

1. The Electron main process listens on `127.0.0.1:<random port>`, creates `codeVerifier`
   (43–128 chars), `challenge = base64url(sha256(verifier))` and a random `state`.
2. It opens the system browser at
   `{API}/cuenta/conectar?challenge=…&state=…&port=…&device=<name>`.
3. Not signed in → redirect to `/cuenta?volver=<that URL>` (only relative `/cuenta…` paths are
   accepted as `volver`). The user signs in with Google or an email code and comes back.
4. Signed in → «¿Conectar este ordenador («{device}») a tu cuenta?» with a **Conectar** button.
   The explicit click prevents login CSRF and silent linking.
5. The button posts a form to `POST /v1/app-auth/authorize` (`challenge`, `state`, `port`;
   cookie session + Origin check). The server stores a one-time code (32 random bytes, only its
   SHA-256 in `app_auth_codes`, valid 60 s) and answers
   `303 Location: http://127.0.0.1:<port>/callback?code=…&state=…`. Only the literal
   `127.0.0.1`, a port 1024–65535 and that fixed path are ever produced (no open redirect).
6. The app checks `state` and calls `POST /v1/app-auth/token` (`AppTokenRequest`). The server
   deletes the code row and reads it in one statement (single use), checks expiry and
   `base64url(sha256(codeVerifier)) === challenge` (timing-safe), creates a session with
   better-auth's internal adapter, and upserts the device on `(user_id, install_id)`: logging in
   again on the same machine reuses the device (its stats are not double-counted) and revokes
   its previous session. At most 10 devices (409 `limit_reached`).
   Response: `AppTokenResponse { token, expiresAt, deviceId, me }`.
7. The app stores the token with `safeStorage` and sends it as a bearer token from the main
   process only.
8. `POST /v1/app-auth/logout` deletes the calling session (204); the device row and its stats
   stay. `DELETE /v1/devices/:id` removes the device, its stats and its session.

Fallback if a loopback port cannot be opened: better-auth's `device-authorization` plugin
(RFC 8628) — not built now. No `centrate://` deep links (fragile on Linux, another app can
claim the scheme).

### 4.3 Fresh sessions

`DELETE /v1/me` needs a session created less than 15 minutes ago
(`requireFreshSession`), else 403 `reauth_required`. The app then runs the loopback login again
(a new session) and retries; the web panel sends the user to `/cuenta` to sign in again.

## 5. Endpoints

Conventions:

- JSON in and out; bodies validated with zod `.strict()` schemas typed
  `satisfies z.ZodType<SharedType>` against `cloud-api.ts`. Timestamps `IsoUtc`, days
  `LocalDay`, absent values `null`, lists `[]` (same rules as `domain.ts`).
- Auth column: **P** public · **S** session (bearer or cookie) · **C** cookie session only ·
  **F** fresh session. Every `/v1` route is **S** unless marked.
- Errors: `CloudErrorBody = { error: { code, message, …extras } }`. `message` is English for
  developers; the app maps `code` to Spanish copy. Extras: `feature`, `reason`, `consent`,
  `issues`, `retryAfterSeconds`, `resetsAt`.
- Things hidden by a block, other people's objects and unknown ids are the same 404.

| Code                   | HTTP | When                                                           |
| ---------------------- | ---- | -------------------------------------------------------------- |
| `validation_failed`    | 400  | Body, query or params rejected (`issues`, values never echoed) |
| `unauthorized`         | 401  | No session, expired or revoked → the app logs out, keeps data  |
| `forbidden`            | 403  | Not yours, or a cookie request without a valid `Origin`        |
| `reauth_required`      | 403  | Needs a fresh session                                          |
| `consent_required`     | 403  | The switch named in `consent` is off                           |
| `not_found`            | 404  |                                                                |
| `conflict`             | 409  | Duplicate (partner link exists…)                               |
| `profile_incomplete`   | 409  | Social features need a display name                            |
| `limit_reached`        | 409  | Devices, friends, invites or partners at their maximum         |
| `deadline_passed`      | 409  | Approval decision after the deadline                           |
| `already_decided`      | 409  | Approval already approved or denied                            |
| `payload_too_large`    | 413  |                                                                |
| `coach_refused`        | 422  | The model declined (`stop_reason: refusal`)                    |
| `rate_limited`         | 429  | `retryAfterSeconds` + `Retry-After` header                     |
| `quota_exceeded`       | 429  | Daily AI quota (`resetsAt`)                                    |
| `internal_error`       | 500  |                                                                |
| `not_implemented`      | 501  | Stubs only                                                     |
| `coach_incomplete`     | 502  | The model hit `max_tokens` or returned nothing parseable       |
| `feature_disabled`     | 503  | `feature` + `reason`                                           |
| `database_unavailable` | 503  | Postgres does not answer                                       |
| `coach_unavailable`    | 503  | Anthropic unreachable, overloaded or rate-limited              |

### 5.1 Health and account

| Method and path               | Auth | Request → response                                                     | Owner |
| ----------------------------- | ---- | ---------------------------------------------------------------------- | ----- |
| GET `/health`                 | P    | → `HealthResponse { ok, version, now, db, serverEpoch, capabilities }` | —     |
| GET, POST `/api/auth/*`       | P    | better-auth (Google, email code, sign-out, session)                    | CORE  |
| POST `/v1/app-auth/authorize` | C    | form `{challenge, state, port}` → 303 to the loopback                  | CORE  |
| POST `/v1/app-auth/token`     | P    | `AppTokenRequest` → `AppTokenResponse`                                 | CORE  |
| POST `/v1/app-auth/logout`    | S    | → 204                                                                  | CORE  |
| GET `/v1/me`                  | S    | → `MeResponse { user, profile, sharing, consentUpdatedAt }`            | CORE  |
| PATCH `/v1/me`                | S    | `PatchMeRequest { profile?, sharing? }` → `MeResponse`                 | CORE  |
| GET `/v1/me/export`           | S    | → `CloudExport` as an attachment (`centrate-datos.json`)               | CORE  |
| DELETE `/v1/me`               | F    | `{ confirm: 'BORRAR' }` → 204, hard delete with cascade                | CORE  |
| GET `/v1/devices`             | S    | → `DevicesResponse`                                                    | CORE  |
| PATCH `/v1/devices/:id`       | S    | `{ name }` → `CloudDevice`                                             | CORE  |
| DELETE `/v1/devices/:id`      | S    | → 204 (device, its stats and its session)                              | CORE  |

`PATCH /v1/me` rules: `displayName` trimmed 1–40 chars without control characters;
`timeZone` a valid IANA zone; `dailyGoalMinutes` 15–600 or null. `sharing.ranking: true` needs
`syncStats` on (already or in the same request), else 400; `syncStats: false` also turns
`ranking` off (a database CHECK enforces it). Turning `presence` off deletes the presence row.
Turning `syncStats` off keeps uploaded stats (the app offers «Borrar también los datos subidos»,
which calls `DELETE /v1/sync/days`). Any switch change sets `consentUpdatedAt`.

### 5.2 Sync and stats (CORE)

| Method and path                   | Auth | Request → response                                                    |
| --------------------------------- | ---- | --------------------------------------------------------------------- |
| GET `/v1/sync/state?deviceId=`    | S    | → `SyncStateResponse { serverEpoch, deviceId, revs }` (last 400 days) |
| PUT `/v1/sync/days`               | S    | `PutDaysRequest { deviceId, days ≤ 100 }` → `{ accepted, stale }`     |
| DELETE `/v1/sync/days[?deviceId]` | S    | → 204, deletes the caller's cloud stats                               |
| GET `/v1/stats?from&to`           | S    | → `StatsResponse { days (merged), deviceDays, devices }`, ≤ 400 days  |

`PUT` needs `sharing.syncStats` (403 `consent_required`) and a bearer session bound to
`deviceId` (another device → 403, someone else's → 404). See §7.

### 5.3 Friends, blocks, ranking, presence (SOCIAL)

| Method and path                         | Auth | Request → response                                               |
| --------------------------------------- | ---- | ---------------------------------------------------------------- |
| POST `/v1/friends/invites`              | S    | `{ maxUses? }` → `CreateInviteResponse { id, code, url, … }`     |
| GET `/v1/friends/invites`               | S    | → `InvitesResponse` (own active invites, no codes)               |
| DELETE `/v1/friends/invites/:id`        | S    | → 204                                                            |
| GET `/v1/friends/invites/:code`         | S    | → `InvitePreviewResponse { inviter: { displayName } }`           |
| POST `/v1/friends/invites/:code/accept` | S    | → `AcceptInviteResponse { friend }`                              |
| GET `/v1/friends`                       | S    | → `FriendsResponse`                                              |
| DELETE `/v1/friends/:userId`            | S    | → 204 (both sides)                                               |
| GET `/v1/blocks`                        | S    | → `BlocksResponse`                                               |
| POST `/v1/blocks`                       | S    | `{ userId }` → 204                                               |
| DELETE `/v1/blocks/:userId`             | S    | → 204 (does not restore the friendship)                          |
| GET `/v1/ranking?week=YYYY-Www`         | S    | → `RankingResponse` (needs `sharing.ranking`)                    |
| PUT `/v1/presence`                      | S    | `{ state, endsAt }` → `{ expiresAt }` (needs `sharing.presence`) |
| DELETE `/v1/presence`                   | S    | → 204                                                            |
| GET `/v1/friends/presence`              | S    | → `FriendsPresenceResponse` (needs `sharing.presence`)           |

### 5.4 Accountability (SOCIAL)

| Method and path                               | Auth | Request → response                                                 |
| --------------------------------------------- | ---- | ------------------------------------------------------------------ |
| GET `/v1/partners`                            | S    | → `PartnersResponse` (as owner and as partner)                     |
| POST `/v1/partners`                           | S    | `{ friendId, requireApproval }` → `PartnerLink` (pending)          |
| POST `/v1/partners/:id/accept`                | S    | (partner) → `PartnerLink`                                          |
| PATCH `/v1/partners/:id`                      | S    | (owner) `{ requireApproval }` → `PartnerLink`                      |
| DELETE `/v1/partners/:id`                     | S    | → 204 (removed now) or 200 `PartnerLink` (ends in 24 h)            |
| POST `/v1/accountability/events`              | S    | `PostAccountabilityEventRequest` → 201/200 `{ eventId, approval }` |
| GET `/v1/accountability/events/:id`           | S    | (owner) → `AccountabilityEventResponse`                            |
| GET `/v1/accountability/inbox`                | S    | (partner) → `InboxResponse`                                        |
| POST `/v1/accountability/events/:id/decision` | S    | (partner) `{ decision, note }` → `ApprovalState`                   |

### 5.5 Coach (COACH)

All need the `coach` capability (503 otherwise) and `sharing.coach` (403 `consent_required`),
except `GET /v1/coach/quota`, which needs only the capability.

| Method and path                 | Request → response                                                              |
| ------------------------------- | ------------------------------------------------------------------------------- |
| GET `/v1/coach/quota`           | → `CoachQuotaResponse { interpret, coach, resetsAt }`                           |
| POST `/v1/coach/interpret`      | `InterpretRequest { text, timeZone, now }` → `{ canonicalText, clarification }` |
| POST `/v1/coach/split-task`     | `SplitTaskRequest` → `SplitTaskResponse { steps (2–12), firstStepTip }`         |
| POST `/v1/coach/study-plan`     | `StudyPlanRequest` → `StudyPlanResponse { days (≤ 60), advice }`                |
| POST `/v1/coach/weekly-summary` | `WeeklySummaryRequest { week, stats }` → `{ headline, highlights, suggestion }` |

### 5.6 Pages (HTML, §11)

`/cuenta` · `/cuenta/codigo` · `/cuenta/conectar` · `/cuenta/assets/:name` (CORE) ·
`/cuenta/panel` · `/cuenta/avisos` (CLIENT) · `/i/:code` (SOCIAL).

## 6. Database

Postgres through Drizzle (`src/db/schema.ts`), 18 tables. Conventions: `timestamptz`
everywhere; `day` columns are `date` holding the civil date of whoever produced the number
(never converted to UTC); app ids are `uuid` (`gen_random_uuid()`), user ids are better-auth's
text ids; **every foreign key to `user` cascades**, so deleting the user row erases everything
about them (the one exception is `accountability_events.decided_by`, set null).

| Table                   | Key                                   | Holds                                                                                         |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `user`                  | `id`                                  | better-auth: email, verified flag. `name` never shown, `image` null                           |
| `session`               | `id`, unique `token`                  | better-auth; `token` is also the bearer token. IP and UA null                                 |
| `account`               | `id`                                  | better-auth: provider links (Google tokens encrypted)                                         |
| `verification`          | `id`                                  | better-auth: email codes                                                                      |
| `profiles`              | `user_id`                             | display name, time zone, daily goal, five sharing switches, consent time                      |
| `devices`               | `id`, unique `(user_id, install_id)`  | connected computers, bound `session_id`, `last_sync_at`                                       |
| `app_auth_codes`        | `code_hash`                           | loopback login codes (hash, challenge, port, 60 s)                                            |
| `daily_stats`           | `(device_id, day)`                    | numbers only (§7). CHECKs: minutes 0–1440, study ≤ focus, counters 0–10 000, points 0–100 000 |
| `friend_invites`        | `id`, unique `code_hash`              | invite hashes, uses, expiry                                                                   |
| `friendships`           | `(user_id, friend_id)`                | two symmetric rows per friendship                                                             |
| `user_blocks`           | `(blocker_id, blocked_id)`            |                                                                                               |
| `presence`              | `user_id`                             | state, since, endsAt, expiresAt                                                               |
| `partner_links`         | `id`, unique `(owner_id, partner_id)` | status, requireApproval, approvalOffAt, endsAt                                                |
| `accountability_events` | `id`, unique `(owner_id, client_ref)` | kind, times, approval status/deadline/decider/note (≤ 140)                                    |
| `usage_counters`        | `(user_id, day, key)`                 | small daily counters (`partner_email`)                                                        |
| `ai_usage`              | `(user_id, day, feature)`             | requests, reserved/used tokens, cost. **No text**                                             |
| `ai_global_daily`       | `day`                                 | global requests, cost, reserved cost                                                          |
| `meta`                  | `key`                                 | `server_epoch`, `janitor_last_run`                                                            |

**Migrations.** `npm run db:generate -w apps/api` writes SQL to `apps/api/drizzle/` (commit it,
then run prettier on `drizzle/meta/*.json`). The server applies migrations at boot under a
Postgres advisory lock (Render's free plan has no pre-deploy command); tests apply the same
files to PGlite. Until the first deploy there is a single `0000_init` migration: a builder who
must change the schema edits `schema.ts`, deletes `apps/api/drizzle/`, regenerates with
`--name init` and says so in their report (the coordinator regenerates once after merging).

**Retention** (CORE's janitor, at boot and hourly under `pg_try_advisory_lock`; reads never
depend on it, they filter by time):

| Data                                        | Deleted                                          |
| ------------------------------------------- | ------------------------------------------------ |
| `presence`                                  | past `expires_at`                                |
| `app_auth_codes`, `verification`, `session` | past `expires_at`                                |
| `friend_invites`                            | 30 days after expiry or after the last use       |
| `partner_links`                             | when `ends_at` passes; `approval_off_at` applied |
| `accountability_events`                     | 30 days after creation                           |
| `usage_counters`                            | after 7 days                                     |
| `ai_usage`, `ai_global_daily`               | after 90 days                                    |
| `daily_stats`                               | days older than 2 years                          |

## 7. Sync model

- **Absolute values, one writer per row.** Each machine uploads its absolute totals per
  `(device, local day)` (`CloudDayStats`), computed from its own guardian event log. Only the
  owning device writes its rows, so devices never conflict.
- **Idempotent upsert:**
  `INSERT … ON CONFLICT (device_id, day) DO UPDATE SET … WHERE excluded.rev >= daily_stats.rev`.
  `rev` is the guardian event `seq` of the last event counted into that day, so it only grows
  on one machine; replaying a request is harmless and an equal `rev` overwrites (lets a fixed
  bug resend). A lower `rev` is ignored and returned in `stale`.
- **Validation:** at most 100 days per request, no duplicate days, every day in
  `[today − 400, today + 1]` for the profile's time zone, numbers within the CHECK ranges (400
  before the database sees them). `devices.last_sync_at` is updated.
- **Reset source:** if the guardian's data is lost and `seq` restarts, the app rotates its
  `installId`, which makes a new device, so a reset sequence never collides with old rows.
- **Read-back:** `GET /v1/stats` sums devices per day (`focusMinutes` capped at 1440,
  `studyMinutes` capped at focus) and sets `goalMet` against the profile's goal; `deviceDays`
  lets one computer show «tus otros ordenadores» without double-counting itself.
- **Database replaced:** `serverEpoch` (in `/health` and `/v1/sync/state`) changes when the
  free Postgres is recreated; the app calls `GET /v1/sync/state`, re-uploads what the server
  lacks and tells the user «La nube se ha reiniciado». Friendships, invites and partner links
  are lost; the app says so.
- **Trust:** stats are self-reported and could be forged. Acceptable: rankings are among
  friends only and never public, and the caps bound abuse. Documented, not defended further.

## 8. Friends, ranking and presence (SOCIAL)

### 8.1 Friends by invitation only

- There is no user search and no directory, so users cannot be enumerated.
- **Codes:** 10 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 50 bits), shown
  as `XXXXX-XXXXX`, stored only as the SHA-256 of the normalized code (upper case, no dashes or
  spaces, `I/L → 1`, `O → 0`). Valid 7 days, `maxUses` 1–10 (default 1), at most 5 active
  invites per user. URL: `{BETTER_AUTH_URL}/i/{code}`.
- **Preview and accept** answer the same 404 for unknown, expired, used up, own and blocked
  (either direction) codes. Lookups are rate-limited (20 per hour per user).
- **Accept** needs the caller's display name (409 `profile_incomplete`). Already friends → 200
  with the friend, no use consumed. Otherwise, in one transaction: increment `uses` only
  `WHERE uses < max_uses`, insert both friendship rows. At most 100 friends each
  (409 `limit_reached`).
- **Remove friend:** deletes both rows (idempotent 204) and the partner links between the two,
  except that an owner cannot bypass the cooling-off (§9): an active link where the caller is
  the owner goes to «ending in 24 h» instead.
- **Block:** removes the friendship, hides both people from each other everywhere (friends,
  presence, ranking, previews) and stops future invites both ways; partner links follow the
  same cooling-off rule as removal. Blocking an unknown id is a silent 204.
- Payloads show other people only as `{ userId, displayName }`. Never an email (tested with a
  scan of every social response for `@`).

### 8.2 Weekly ranking

- `week` is `YYYY-Www` (`isoWeekRange`, 53-week years included: 2026-W53 is 2026-12-28 …
  2027-01-03). Omitted → the current ISO week in the caller's time zone (`localDayIn` +
  `isoWeekOf`). Invalid → 400.
- Needs `sharing.ranking` (reciprocity). Entries: the caller plus friends with ranking on,
  minus blocks.
- Per user and day: `SUM(focus_minutes)` across devices capped at 1440 (study capped at
  focus). `activeDays` = days with focus > 0; `goalDays` = days meeting that person's own goal.
  `day` values are each user's civil dates, so everyone is compared Monday–Sunday in their own
  zone.
- Order: focus minutes desc, active days desc, display name (`es` collation), user id.
  Competition ranking on (minutes, active days): 1, 2, 2, 4.
- Points are not shared (they can be negative and are more personal).

### 8.3 «Estudiando ahora»

- `PUT /v1/presence` (needs `sharing.presence`) upserts `expires_at = now + 180 s`; `since` is
  kept while the state is unchanged and the row alive, else reset to now. `endsAt` must be in
  `(now, now + 24 h]` or null. The app sends a heartbeat every 60 s during a block or study
  session and `DELETE` when it ends; a crash disappears within 3 minutes.
- Readers see only rows with `expires_at > now` (no dependence on the janitor), of friends who
  share presence, and only if the reader shares too. Friends see state, since and endsAt:
  never what is blocked or the task.
- «Estudiar juntos» is a desktop feature on top of this: «Unirme» creates a local session
  ending at the friend's `endsAt` (the user confirms locally). No server state.
- Heartbeats are never queued offline (an old heartbeat means nothing). No WebSockets: the
  free service sleeps; the Amigos window polls every 60 s while open.

## 9. Accountability partner (SOCIAL)

- **Setup:** the owner (the person held accountable) proposes a friend; the partner must
  accept. At most 3 links per owner (pending or active). Needs display names.
- **Weakening takes 24 hours; strengthening is immediate.** Owner removes an active link →
  `ends_at = now + 24 h` (alerts keep flowing until then). Owner turns approval off →
  `approval_off_at = now + 24 h` (approval still required until then). Adding a partner or
  turning approval on is immediate. The partner can leave immediately, and a pending link is
  removed immediately. Unfriending or blocking cannot shortcut this (§8.1). Effective state is
  computed on read (`ends_at`/`approval_off_at` in the past count as applied).
- **Events:** the app reports `emergency_requested`, `emergency_confirmed`,
  `emergency_cancelled`, `study_abandoned`, `punishment_started` with a random `clientRef`
  (16–64 chars) from its offline outbox. `(owner_id, client_ref)` is unique: a replay returns
  the stored event with 200 (a new one is 201). `occurredAt` must be within
  `[now − 7 days, now + 5 min]`. No reason, domain, task or note from the owner is accepted.
- **Who hears:** partners of active (or ending) links accepted before the event. The inbox
  (`GET /v1/accountability/inbox`) lists their owners' events of the last 30 days, newest first
  (≤ 100). Email (Resend) only when the partner turned `partnerEmails` on, only for
  `emergency_requested`, `emergency_confirmed` and `study_abandoned`, at most 10 per partner per
  day (`usage_counters.partner_email`). Emails are minimal Spanish text, times in the partner's
  zone: «Dani ha pedido el desbloqueo de emergencia (18:40)». With a pending approval they add
  «Puedes aprobarlo o rechazarlo hasta las 18:55 en Céntrate o en {URL}/cuenta/avisos». Never a
  reason, domain, task or points.

### Approval flow (never blocks the guardian)

1. Only for `emergency_requested` with `countdownEndsAt ≥ now + 60 s`, when the owner has at
   least one active link with approval effectively on. Else `approval: null`.
2. `deadline = min(countdownEndsAt, now + 30 min)`: the approval never adds waiting time on top
   of the guardian's own local countdown, which keeps running unchanged.
3. The app polls `GET /v1/accountability/events/:id` every 15 s. `expired` is computed on read
   (pending past its deadline).
4. **Approved** → the usual confirm button at the end of the countdown (approval never
   shortens it). **Denied** → the app shows «Tu compañero ha dicho que no» and cancels _this_
   emergency request through the guardian's existing cancel endpoint; the block stays. The user
   may ask again after a local 15-minute cooldown (a new request, a new approval).
   **Expired, 5xx, timeout or offline** → treated as approved (fail open); the partner later
   sees «no respondió».
5. Decisions: only a partner with an active link to the owner; first decision wins
   (`UPDATE … WHERE approval_status = 'pending'`); after the deadline 409 `deadline_passed`;
   already decided 409 `already_decided`; optional note ≤ 140 chars.

Hardcore and Exam modes have no emergency unlock, so they never reach this flow.

## 10. Coach (COACH, Claude API)

The Anthropic key lives only in the backend environment. Model choice and SDK usage follow the
`claude-api` skill (2026-09):

| Endpoint         | Model (env override)                      | Settings                                                            | `max_tokens` |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------- | ------------ |
| `interpret`      | `claude-haiku-4-5` (`AI_MODEL_INTERPRET`) | no thinking, no effort (Haiku 4.5 rejects it), `temperature: 0`     | 1024         |
| `split-task`     | `claude-opus-5` (`AI_MODEL_COACH`)        | adaptive thinking (Opus 5's default: omit `thinking`), effort `low` | 8000         |
| `study-plan`     | `claude-opus-5`                           | effort `medium`                                                     | 16000        |
| `weekly-summary` | `claude-opus-5`                           | effort `low`                                                        | 4000         |

- **One client**: `new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })`, created only
  when the key is set and `AI_ENABLED` is true, behind the `CoachModel` seam
  (`src/coach/model.ts`) so tests inject a fake.
- **Structured outputs**: `messages.parse` with `output_config: { format: zodOutputFormat(schema) }`
  (`@anthropic-ai/sdk/helpers/zod`); Opus calls add `effort` to the same `output_config`.
  Non-streaming (all `max_tokens` ≤ 16 000).
- **Refusal fallbacks (Opus)**: per the skill, enabled by default: the beta namespace with
  `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`. It changes
  behaviour: a refused request may be answered by a fallback model. If SDK 0.128 lacks it,
  drop it and note it here.
- **Always check `stop_reason`** before reading output: `refusal` → 422 `coach_refused`;
  `max_tokens` or a null `parsed_output` → 502 `coach_incomplete`.
- **SDK errors**, most specific first: `RateLimitError`, `APIConnectionError`, 5xx/overloaded →
  503 `coach_unavailable`; `AuthenticationError`/`PermissionDeniedError` → 503
  `coach_unavailable` and an error log (misconfigured key, by class name only);
  `BadRequestError` → 500 `internal_error`, logged by class only.
- **Prompt caching**: each endpoint has one frozen Spanish system prompt with
  `cache_control: { type: 'ephemeral' }` (deterministic: no dates, ids or unsorted data).
  Everything variable goes in the user message, the user's text wrapped in
  `<datos_usuario>…</datos_usuario>` and treated as data, never instructions. Opus 5 caches
  prefixes from 512 tokens; Haiku 4.5 needs 4096, so the interpret prompt may silently not
  cache — acceptable at this size. A unit test checks `cache_control` is set.
- **`metadata.user_id`** = first 32 hex chars of HMAC-SHA256(`BETTER_AUTH_SECRET`,
  `anthropic:` + userId). Never the id or email.
- **Tone**: Spanish (Spain), sentence case, typographic «−», encouraging, never shaming. If the
  text suggests distress, the answer is kind and mentions the 024 line (Spain).
- **Nothing the model returns is executed**; every output is validated again on the server.

### 10.1 Endpoint behaviour

- **interpret** runs only when the user taps «Preguntar al coach» under «No he entendido: …»,
  or turned on «Usar IA cuando no entienda la frase» in the app. The model rewrites the phrase
  into the local grammar (`canonicalText`, e.g. «no veo youtube ni instagram durante 90
  minutos») or asks back (`clarification`). The server accepts `canonicalText` only if the
  shared `parseIntent` reads it with `kind ≠ 'unknown'` and nothing unparsed, using a clock
  shifted so `now.getHours()` reads the user's wall time in `timeZone` (the parser reads local
  time; the server runs in UTC). Otherwise `canonicalText: null` and a generic Spanish
  clarification. The prompt forbids adding targets or durations the text does not imply. The
  **desktop re-parses `canonicalText` locally** (correct zone) and always shows the
  confirmation card; nothing goes straight to a block.
- **split-task**: 2–12 steps, titles ≤ 80, minutes 5–120, tip ≤ 200. Each `suggestedPhrase`
  must parse locally with `complete: true`, else it becomes null (one-tap «Empezar»).
- **study-plan**: the server clamps days to `[today, examDate − 1]` (≤ 60 days), drops
  `daysOff` weekdays, scales each day to `dailyMinutes`, keeps topics ≤ 80 chars and advice
  ≤ 5 items. `examDate` must be after `today` (400).
- **weekly-summary**: with `syncStats` on, the input is built on the server from `daily_stats`
  (the week plus the previous 3 week totals, numbers only); otherwise `stats` is required and
  processed, not stored. No summary text is stored (the app caches its own).

### 10.2 Quotas and budget

- Per user per UTC day: `interpret` requests, `coach` requests (split-task, study-plan,
  weekly-summary) and tokens (input + output of both). Global: estimated spend per UTC day
  against `AI_GLOBAL_DAILY_BUDGET_USD`.
- **Reserve, call, settle.** Before calling, one atomic statement reserves a request and the
  worst-case tokens (`INSERT … ON CONFLICT (user_id, day, feature) DO UPDATE SET requests =
  requests + 1, reserved_tokens = reserved_tokens + $w WHERE requests < $max AND used + reserved
  - $w ≤ $maxTokens RETURNING`); no row → 429 `quota_exceeded`with`resetsAt`(next 00:00
UTC). The same pattern on`ai_global_daily`with the worst-case cost; no row → 503`feature_disabled` (`reason: 'budget'`) and `/health`shows it. After the call the reservation
is replaced by the real`usage` (input, output, cache read/write) and its cost; a provider
    error releases the tokens but keeps the request counted. 20 parallel requests with a limit of
    10 must yield exactly 10 calls (tested).
- **Prices** (micro-USD per token, in `src/coach/`): `claude-haiku-4-5` 1 in / 5 out,
  `claude-opus-5` 5 in / 25 out; cache writes 1.25× input, cache reads 0.1× input; an unknown
  model is billed at the Opus rate (conservative).
- No prompt or answer text is stored or logged; only `ai_usage` counters change (tested by
  scanning every table after each coach test).

## 11. Web pages

The API serves a few HTML pages itself: `onrender.com` is on the Public Suffix List, so a page
on the static site (`centrate.onrender.com`) could not use the API's cookies
(`centrate-api.onrender.com` is a different site), and a token in `localStorage` would be
readable by any XSS. The static site stays untouched.

- **Shell and escaping:** `src/pages/layout.ts` (`page()`, the escaping `html` tag, `raw` for
  trusted SVG, the asset registry). Spanish copy, sentence case, `lang="es"`, `noindex`.
- **Styles:** `tokens.css` from `@centrate/shared/design` plus `pages.css`, served from
  `/cuenta/assets/`. Colors only from the tokens; light and dark follow the system.
- **CSP** (app.ts): `default-src 'self'`, no inline scripts or styles, `form-action 'self'
http://127.0.0.1:*` (the connect form redirects to the loopback), `frame-ancestors 'none'`.
  Page scripts are registered assets; charts are SVG built from numbers (server-side `raw` or
  DOM calls in page scripts).

| Page               | Owner  | What                                                                                                                                                                                                                                                      |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cuenta`          | CORE   | «Continuar con Google» and «Recibir un código por email»; signed in: email, links to the panel, «Cerrar sesión». Notice «Debes tener al menos 14 años» (LOPDGDD art. 7) and a link to the privacy page. `?volver=` accepts only relative `/cuenta…` paths |
| `/cuenta/codigo`   | CORE   | Landing of the email link; reads `email` and `otp` from the fragment; «Entrar» signs in                                                                                                                                                                   |
| `/cuenta/conectar` | CORE   | §4.2 steps 3–5                                                                                                                                                                                                                                            |
| `/cuenta/panel`    | CLIENT | Charts of the last 12 weeks (focus and study minutes, points won and lost, goal days) from `GET /v1/stats`; devices with «Quitar»; «Descargar mis datos»; «Borrar mi cuenta» (typed confirmation, re-sign-in when not fresh)                              |
| `/cuenta/avisos`   | CLIENT | A partner's inbox: recent alerts, «Aprobar» / «Rechazar» for pending approvals                                                                                                                                                                            |
| `/i/:code`         | SOCIAL | Public invite landing: «Te han invitado a Céntrate», the code with «Copiar», how to add it in the app (Amigos → «Tengo un código»), download link. Never looks the code up or shows who invited                                                           |

Pages that need a session redirect to `/cuenta?volver=…`. They call the JSON API with the
cookie session from their own scripts (same origin; §4.1 CSRF rule applies).

## 12. Rate and size limits

`@fastify/rate-limit`, in memory (one instance; a restart after sleeping resets counters, so
anything that must hold across restarts, AI quotas and partner emails, lives in Postgres).
Key: `u:<userId>` when a session resolved, else `ip:<client ip>` (`TRUST_PROXY_HOPS=1` on
Render). 429 carries `retryAfterSeconds` and `Retry-After`.

| Scope                                       | Limit                                     |
| ------------------------------------------- | ----------------------------------------- |
| Everything (default)                        | 120 per minute                            |
| `/health`                                   | not limited                               |
| Email code send (better-auth `customRules`) | 5 per 15 min per IP, 3 per hour per email |
| `POST /v1/app-auth/authorize`, `/token`     | 20 per hour                               |
| `PUT /v1/sync/days`                         | 60 per hour                               |
| `PUT /v1/presence`                          | 4 per minute                              |
| `POST /v1/friends/invites`                  | 10 per day                                |
| Invite preview and accept                   | 20 per hour                               |
| Accountability events and decisions         | 30 per hour                               |
| `/v1/coach/*` (plus the daily quotas)       | 10 per minute                             |
| `GET /v1/me/export`, `DELETE /v1/me`        | 3 per hour                                |

Body limits: 32 KB by default, 256 KB for `PUT /v1/sync/days`, 16 KB for coach routes, 4 KB
for urlencoded forms.

## 13. Privacy, logging and GDPR

- **What leaves the machine, per switch** (all off by default): `syncStats` → the numeric
  `CloudDayStats`; `ranking` → friends see weekly focus/study minutes, active days, goal days;
  `presence` → friends see focus/study, since, ends; accountability → partners see event kind,
  time and the approval outcome; `coach` → the text the user typed for that request goes to
  Anthropic (processed in the United States under Anthropic's API terms), is never stored by
  us, and the first use shows a notice in the app.
- **Logs** (pino): one line per request with request id, method, **route pattern** (never the
  raw URL: codes and tokens travel in paths), status and duration. No IPs, user agents,
  headers, query strings, bodies, emails or tokens; serializers and `redact` enforce it, and a
  test scans captured output. Errors are logged by type and code (plus stack for 5xx), never
  by message (messages can quote values). Prompts and answers are never logged.
- **Security headers:** helmet (strict CSP above, `Referrer-Policy: no-referrer`, HSTS in
  production); `Cache-Control: no-store` on every response.
- **GDPR:** `GET /v1/me/export` (every row about the user; other people only as id and display
  name; no tokens or hashes) and `DELETE /v1/me` (hard delete by cascade, plus the user's
  `verification` rows by identifier). A test enumerates every table with a user column from the
  schema, so a new table fails until export and deletion cover it.
- **Retention:** §6. **Region:** Frankfurt (EU).
- **Age:** Spain requires 14 to consent (LOPDGDD art. 7); the sign-in page says so.
- `PRIVACY.md` (another team) must gain: what each switch shares, the Anthropic processing
  notice, retention times, the region, and how to export or delete.

## 14. Desktop client contract

For the desktop team (and the CLIENT builder's `cloud-api.ts` client):

- **Only the Electron main process calls the API.** The token lives in `safeStorage`; the
  renderer never sees it and CORS never applies.
- **The UI never waits on the API.** Timeouts (`CLOUD_TIMEOUTS`): background 10 s, user-started
  60 s with «Despertando el servidor…» (a cold start takes about a minute), coach 90 s. At app
  start, when signed in, fire a `GET /health` to wake the service.
- **Errors** (`CloudError { kind: 'offline' | 'timeout' | 'http', status, code, retryable,
retryAfterMs }`): retry network errors, timeouts, 429 (honouring `Retry-After`) and 5xx
  except `feature_disabled`; never retry other 4xx. **401** → mark the app as signed out, drop
  the outbox, keep all local data.
- **Offline outbox** (persisted by the app in its SQLite; the shared helpers are pure):
  - `putDays` items collapse by `(deviceId, day)` keeping the highest `rev`, sent in batches of 100.
  - Accountability events keep their `clientRef` and are never merged away.
  - Presence heartbeats and approval polls are never queued.
  - Backoff with jitter from 30 s to 30 min.
- **Polling:** approval every 15 s while a request is pending; inbox and friends' presence
  every 60 s while the Amigos window is open; ranking on open.
- **`serverEpoch` changed** → `GET /v1/sync/state`, re-upload what is missing, show «La nube se
  ha reiniciado».
- **Feature discovery:** read `capabilities` from `/health` and hide what is off.

## 15. Deploying on Render

`render.yaml` gains (CLIENT; the static site entry stays exactly as it is):

- **Web service** `centrate-api`: `runtime: node`, `plan: free`, `region: frankfurt`,
  `buildCommand: npm ci && npm run build -w apps/api`,
  `startCommand: node apps/api/dist/server.mjs`, `healthCheckPath: /health`,
  `buildFilter.paths: [apps/api/**, packages/shared/**, package-lock.json]`.
  Env: `NODE_VERSION=22`, `NODE_ENV=production`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`,
  `TRUST_PROXY_HOPS=1`, `AI_ENABLED=true`; `DATABASE_URL` from the database's
  `connectionString`; `BETTER_AUTH_SECRET` with `generateValue: true`; `BETTER_AUTH_URL`,
  `APP_ORIGINS`, Google, Resend and Anthropic keys with `sync: false` (filled in the dashboard;
  left empty means off).
- **Database** `centrate-db`: `plan: free`, `region: frankfurt`, `ipAllowList: []` (reachable
  only from Render's private network).

**Free-tier limits the app is built around:**

- The free web service **spins down after 15 minutes without traffic**; the next request waits
  for a cold start of about a minute. Free instance hours are capped per workspace each month
  (750 h at the time of writing). Presence heartbeats keep it awake only while someone is
  focusing.
- The free Postgres **expires** (30 days after creation at the time of writing, then a short
  grace period before deletion) and has 1 GB. When it is recreated, `serverEpoch` changes and
  the app re-uploads stats (§7); social data is lost. For a durable service, upgrade the
  database (a `PENDIENTE_PARA_MI` item).
- Migrations run at boot (no pre-deploy command on the free plan).
- The Render account is at its 25-service limit (DECISIONS.md), so deploying needs a free slot:
  a `PENDIENTE_PARA_MI` item, like creating the Google OAuth client (redirect
  `{API}/api/auth/callback/google`), verifying a Resend domain and adding the Anthropic key and
  budget.

## 16. Testing

Vitest with PGlite (in-process Postgres) and the real migrations.

- `test/helpers/db.ts`: `createTestDb()` (one per test file), `resetDb()`.
- `test/helpers/app.ts`: `testConfig()` (accounts, Google and email on; no Anthropic key),
  `fakeClock()`, `fakeMailer()`, `createTestUser(db, { displayName, sharing, timeZone,
sessionCreatedAt… })` (user + profile + bearer session), `tokenSessionResolver()` and
  `buildTestApp({ db, clock, … })`. SOCIAL and COACH test through bearer tokens without
  better-auth; CORE tests the real better-auth flows.
- Existing tests: config and capabilities, ISO weeks and local days, health with and without a
  database, the error envelope, log hygiene.

Each builder adds the tests listed in §17. Gates for every builder: `npm run typecheck -w
apps/api`, `npx eslint apps/api` (and `packages/shared` for CLIENT), `npm test -w apps/api`,
`npx prettier --check` on touched files, `npm run build -w apps/api && node
apps/api/dist/server.mjs --check`.

## 17. Work plan per builder

Every builder: edit only your files (§3). If you need a change in a shared file (app.ts,
config.ts, context.ts, schema.ts, errors.ts, guards.ts, cloud-api.ts types), keep it minimal
and additive, and list it in your final report. Do not run `npm install`; no new dependencies
are needed. Follow CLAUDE.md (English code and comments, Spanish user copy, sentence case,
«−»).

### CORE: app, config, database, auth, sync, account, server

- `src/auth/`: better-auth per §4.1, `resolveSession`, `/api/auth/*` bridge, Origin check for
  cookie writes, profile creation hook, email-code sender (Spanish email: code + link).
- `src/lib/mailer.ts`: `createResendMailer(config.email)` (`fetch` to
  `https://api.resend.com/emails`, 10 s timeout, errors logged by status only). Wire the
  default in `buildApp` (`options.mailer ?? …`) and in `server.ts`.
- `routes/app-auth.ts`, `routes/me.ts`, `routes/sync.ts` per §4.2, §5.1, §5.2, §7.
- `pages/account.ts` + `pages.css` + the asset route; `layout.ts` refinements.
- `server.ts`: `ensureServerEpoch`, janitor start, graceful shutdown; `jobs/janitor.ts` per §6.
- Tests: email-code sign-in through `app.inject` (code captured by the fake mailer); Google
  hidden when unconfigured; PKCE happy path, wrong verifier, reused code, code older than 60 s,
  bad port, cookie authorize without `Origin` → 403; bearer works, logout and device delete
  revoke; re-login reuses the device; no IP or UA stored; PATCH rules (ranking needs sync);
  sync idempotency, stale revs, day window, other device 403/404, consent 403, multi-device
  merge with caps; export completeness and deletion leaving 0 rows (schema-driven); fresh
  session rule; janitor.

### SOCIAL: friends, ranking, presence, accountability

- `routes/friends.ts`, `routes/ranking.ts`, `routes/presence.ts`, `routes/accountability.ts`,
  `pages/social.ts` per §5.3, §5.4, §8, §9, §11. Partner emails through `ctx.mailer` (Spanish,
  minimal), counted in `usage_counters`.
- Tests: invite lifecycle (create, preview, accept, expired, used up, own, blocked → identical
  404, max uses, race on the last use); friends limit; remove and block symmetric, with the
  cooling-off rule for owners; no `@` in any social payload; ranking with ISO boundaries
  (2026-W53, Sunday 23:59 in different zones), default week per zone, reciprocity, the 1440 cap,
  tie ranks; presence TTL with the fake clock, since kept, consent both ways, blocks;
  partner lifecycle incl. 24 h delays; events idempotent on `clientRef`; approval approve/deny,
  first wins, late → 409, expired on read, not-a-partner → 404; email content (snapshot of the
  fake mailer: no reason, domain or task) and the 10-per-day cap.

### COACH: coach routes, Anthropic client, quotas

- `routes/coach.ts`, `src/coach/` (`model.ts` seam, `anthropic.ts`, `prompts.ts`, `schemas.ts`,
  `quota.ts`, `budget.ts`, `interpret.ts`) per §10. Wire the default `coachModel` in `buildApp`
  (one line) and nowhere else.
- Tests with a fake `CoachModel`: capability and consent gates; schemas and server-side
  clamping; interpret accepts only phrases `parseIntent` reads fully (an invented service is
  dropped), shifted clock correct across zones; `suggestedPhrase` filtering; refusal → 422,
  `max_tokens` → 502, SDK errors → 503; quota N+1 → 429 with `resetsAt`, 20 parallel with limit
  10 → exactly 10 calls, global budget → 503 `budget` and health shows it, kill switch; no text
  in any table afterwards. One test drives the real SDK against a local fake HTTP server to
  assert model ids, `cache_control` on the system prompt, `max_tokens`, the fallback beta
  header and `metadata.user_id` being the HMAC, and that the key never appears in responses or
  logs.

### CLIENT: shared client, pages, Render, README

- `packages/shared/src/cloud-api.ts`, end of file: `createCloudClient({ baseUrl, getToken,
fetch?, timeouts? })` with one typed method per endpoint, `CloudError`, the outbox helpers
  (`coalesceOutbox`, `nextRetryDelay`, `createOutbox({ storage, client, now })`) per §14. Pure
  TypeScript, no Node imports, erasable syntax only.
- `pages/panel.ts` (`/cuenta/panel`, `/cuenta/avisos`) per §11, with registered scripts.
- `render.yaml` additions per §15 and a README section (Spanish) on the optional cloud.
- Tests (in `apps/api/test/`): the client against `buildTestApp` through a fetch adapter over
  `app.inject`, timeouts and offline with a fetch stub, error mapping and `retryable`, outbox
  coalescing, idempotent replay, backoff bounds; panel and avisos pages render and escape.

### Coordinator notes

- No new npm packages. `esbuild` is already in the tree (used by `build.mjs`); adding it to
  `apps/api` devDependencies would make that explicit.
- Consider adding `apps/api/drizzle` to `.prettierignore` (drizzle-kit rewrites its JSON).
- Other teams: `PRIVACY.md` (§13), `PENDIENTE_PARA_MI.md` (§15), `DECISIONS.md` (§18),
  `ROADMAP.md`, and the desktop integration (§14, §9 approval flow, §10.1 interpret).

## 18. Decisions and rejected alternatives

- **Pages served by the API, not the static site** — cookies cannot cross `onrender.com`
  sites; tokens in `localStorage` are XSS-readable.
- **Email one-time code with a link, not a pure magic link** — a magic link opened on a phone
  signs in the phone, not the computer that is connecting.
- **Loopback + PKCE, not a `centrate://` deep link** — deep-link registration is fragile on
  Linux and hijackable.
- **Interpret returns a canonical phrase re-parsed locally, not a `ParseResult`** — the parser
  reads local wall time and the server runs in UTC; reusing the parser also guarantees nothing
  is invented beyond what it can read.
- **Profile and consent in our own `profiles` table, not better-auth `additionalFields`** —
  keeps better-auth vanilla and consent writes behind our validated `PATCH /v1/me`.
- **Symmetric friendship rows** — trivial queries, one transaction to write.
- **Approval deadline never exceeds the local countdown and fails open** — the partner can
  only make a block last longer, never shorter, and the guardian never depends on the network.
- **Cooling-off cannot be bypassed by unfriending or blocking.**
- **Weekly summaries are not stored** — the app caches them; less personal data in the cloud.
- **Dollar budget, not a token budget, for the global cap** — it is what the owner pays; the
  price table is conservative for unknown models.
- **Rejected for now:** cheers, study rooms, category breakdowns, points snapshots in the cloud,
  public profiles or search, WebSockets (the free service sleeps).
