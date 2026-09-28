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
| `SIGNIN_EMAILS_PER_DAY`                                            | `50`               | Global cap on sign-in code emails per UTC day (§12); `0` = none       |
| `PARTNER_EMAILS_PER_DAY_GLOBAL`                                    | `40`               | Global cap on partner emails per UTC day (§9, §12); `0` = none        |
| `ANTHROPIC_API_KEY`                                                | unset              | Coach and phrase interpretation                                       |
| `AI_ENABLED`                                                       | `true`             | Global kill switch for the coach                                      |
| `AI_MODEL_INTERPRET`                                               | `claude-haiku-4-5` | Fast cheap model for phrases the local parser failed on               |
| `AI_MODEL_COACH`                                                   | `claude-opus-5`    | Capable model for the coach                                           |
| `AI_REFUSAL_FALLBACKS`                                             | `true`             | Server-side refusal fallbacks on Opus 5 / Fable 5.1 (§10)             |
| `AI_USER_DAILY_INTERPRET_REQUESTS`, `AI_USER_DAILY_COACH_REQUESTS` | `30`, `10`         | Per user per UTC day                                                  |
| `AI_USER_DAILY_TOKENS`                                             | `150000`           | Input + output tokens per user per UTC day, all AI features           |
| `AI_USER_DAILY_BUDGET_USD`                                         | `0.5`              | Per-user spend cap per UTC day, both buckets; `0` turns the coach off |
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
`{ enabled, reason }` with `reason ∈ missing_key | kill_switch | budget | database_down`
(`budget`: a daily allowance is spent until 00:00 UTC, the AI budget for `coach`, the
sign-in emails for `emailLogin`; also a cap set to `0`. `kill_switch` for `coach`:
`AI_ENABLED=false`, `meta.ai_kill_switch`, or the breaker, open for 15 minutes after repeated
account-level failures at Anthropic, §10.3):

| Feature          | Needs                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `accounts`       | database + `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` + at least one sign-in method              |
| `googleLogin`    | `accounts` + Google pair                                                                       |
| `emailLogin`     | `accounts` + Resend pair + today's sign-in emails below `SIGNIN_EMAILS_PER_DAY`                |
| `sync`, `social` | `accounts`                                                                                     |
| `partnerEmails`  | `accounts` + Resend pair + `PARTNER_EMAILS_PER_DAY_GLOBAL` > 0                                 |
| `coach`          | `accounts` + `ANTHROPIC_API_KEY` + `AI_ENABLED` + no kill switch or open breaker + budget left |

`GET /health` reports them with the database state and budgets (read at most every 10 s,
§12). A disabled feature answers
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
    server.ts            process entry: config, --check, signals             CORE
    boot.ts              startServer(): pool, migrations with retry, janitor CORE
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
    lib/gdpr.ts          export, account deletion, USER_DATA_COVERAGE         CORE
    lib/counters.ts      durable fixed-window counters (rate_counters)        CORE
    lib/ip-limit.ts      client keys (IPv6 /64), pre-session IP gate          CORE
    lib/in-flight.ts     running handlers, drained by app.close()             CORE
    auth/index.ts        better-auth instance, /api/auth/* routes             CORE
    auth/session.ts      resolveSession (cookie or bearer), createSessionRow  CORE
    auth/csrf.ts         Origin rule for cookie writes and sign-in routes     CORE
    auth/email.ts        the sign-in code email                               CORE
    auth/email-limits.ts sign-in email caps (mailbox, global)                 CORE
    routes/health.ts     GET /health                                          architect
    routes/app-auth.ts   desktop loopback login                               CORE
    routes/me.ts         account, consent, devices, export, delete            CORE
    routes/sessions.ts   browser sessions: list, sign out the others          CORE
    routes/sync.ts       sync and stats                                       CORE
    routes/friends.ts    invites, friends, blocks                             SOCIAL
    routes/ranking.ts    weekly ranking                                       SOCIAL
    routes/presence.ts   «estudiando ahora»                                   SOCIAL
    routes/accountability.ts  partners, events, approvals, inbox              SOCIAL
    routes/coach.ts      coach endpoints                                      COACH
    coach/               model seam, Anthropic client, prompts, schemas,
                         endpoints, service, quota, budget, one module per
                         endpoint                                             COACH
    pages/layout.ts      HTML shell, escaping, asset registry                 CORE (shared use)
    pages/account.ts     /cuenta, /cuenta/codigo, /cuenta/conectar, assets    CORE
    pages/assets.ts      tokens.css, pages.css, cuenta.js                     CORE
    pages/panel.ts       /cuenta/panel, /cuenta/avisos                        CLIENT
    pages/panel-charts.ts  weekly totals, formats, SVG column charts         CLIENT
    pages/panel-assets.ts  panel.css, panel.js, avisos.js                    CLIENT
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
- **Account linking:** a Google sign-in joins an existing account with the same email only when
  Google's token says `email_verified: true` (every Gmail address and every verified one).
  Google is deliberately **not** in `trustedProviders`: a trusted provider skips that check, so
  a Google identity with an unverified address could take over the account created with an
  email code (better-auth's `requireLocalEmailVerified` does not stop it, since code sign-ins
  mark the address verified). An unverified match redirects to
  `/cuenta?error=google&error=account_not_linked` and signs nobody in.
- **Sign-up only with a verified address.** `databaseHooks.user.create.before` refuses a user
  whose `emailVerified` is not true (email-code sign-ups always are; every Gmail and Workspace
  address is): a Google identity whose token says `email_verified: false` creates no user,
  profile, account or session and lands on `/cuenta?error=google&error=email_not_verified`
  («No se ha podido iniciar sesión»). Otherwise it could pre-register someone else's address,
  switch sharing on and plant friends and an accountability partner, and the real owner would
  inherit all of it on their first email-code sign-in (better-auth's
  `revokeUnprovenAccountAccess` then drops only the Google link and the sessions, not our
  tables). As defence in depth `resolveSession` resolves no session of an unverified account.
- **Sessions**, two kinds, told apart by the `devices` row that points at a desktop one:
  - **desktop** (bearer, written by the loopback login, §4.2): 60 days, sliding (extended at
    most once a day by `resolveSession`), so a computer in daily use stays connected;
  - **browser** (cookie, written by better-auth): 14 days from sign-in, never extended
    (`expiresIn` 14 days, `disableSessionRefresh: true`, so not even better-auth's
    `get-session` extends it), so a session left on a shared or lost computer ends on its own.
    `/cuenta` lists them (dates only) and «Cerrar sesión en los demás navegadores» ends every
    other one (`POST /v1/sessions/revoke-others`, §5.1).

  No cookie cache (revocation is immediate). Cookies
  `HttpOnly; Secure (production); SameSite=Lax`, `Max-Age` 14 days, first-party on the API
  domain. `trustedOrigins = [BETTER_AUTH_URL, …APP_ORIGINS]`.

- **Privacy**: `telemetry: { enabled: false }`, `advanced.ipAddress.disableIpTracking: true`,
  user agents not stored (session `create.before` hook), the Google picture not stored
  (`image` always null).
- `databaseHooks.user.create.before` keeps only the first word of the name in `user.name` and
  sets `image` null; `user.create.after` inserts the `profiles` row (`ensureProfile`): every
  switch off, `displayName` = that first name, or null for email sign-ups; then it sets
  `user.name` to `''`, so the name lives only in the display name the user sees and edits (no
  stale Google name behind). `user.update.before` blanks any later name. `getProfile` creates
  the row lazily too. `account` hooks drop the Google access, refresh and id tokens before they
  are stored (we never call Google APIs).
- **Reachable endpoints** (everything else better-auth offers answers our 404), one Fastify
  route each that builds a `Request` and returns `auth.handler(request)`:
  - always: `GET /api/auth/get-session`, `POST /api/auth/sign-out`;
  - with Google: `POST /api/auth/sign-in/social`, `GET /api/auth/callback/google` (errors
    redirect to `/cuenta?error=…`);
  - with email: `POST /api/auth/email-otp/send-verification-otp` (`type: 'sign-in'` only,
    else 400; the sign-in email caps of §12 run before better-auth creates a code) and
    `POST /api/auth/sign-in/email-otp`.

  Every `POST` among them follows the sign-in rule below (JSON from our own pages), checked in
  an `onRequest` hook before the body is read, anything is counted or better-auth is called.

- `createAuth(ctx, log)` returns `{ resolveSession, routes }`. `resolveSession(headers)`
  (`src/auth/session.ts`) reads the session straight from the table on every request: the
  bearer token (raw, or better-auth's signed `token.signature`) or the signed cookie
  `centrate.session_token` (`__Secure-` prefixed over https; signature checked with
  `BETTER_AUTH_SECRET`). Expired or deleted sessions fail at once; a desktop session's expiry
  slides at most once a day, a browser session's never. It returns
  `AuthedUser { userId, sessionId, authenticatedAt, deviceId }` (device = the `devices` row
  whose `session_id` is this session; `authenticatedAt` = when the person last signed in, §4.3)
  or null (also for an account whose address is not verified). better-auth's own messages are
  logged with email addresses scrubbed.
- **CSRF** (`src/auth/csrf.ts`, called from the session hook in app.ts): besides
  `SameSite=Lax`, a state-changing request (not GET/HEAD/OPTIONS) authenticated by **cookie**
  must carry an `Origin` equal to the API origin or one in `APP_ORIGINS`, or
  `Sec-Fetch-Site: same-origin`, else 403 `forbidden`. Bearer requests are exempt (not ambient
  credentials). The API sends `Referrer-Policy: no-referrer`, under which browsers send
  `Origin: null` on same-origin form posts, so every page carries a `referrer` meta tag with
  `same-origin` (layout.ts); the `Sec-Fetch-Site` rule covers the rest.
- **Sign-in rule (login CSRF)** (`assertSignInRequest`, a hook on the `/api/auth` routes): every
  `POST /api/auth/*` must be `Content-Type: application/json` **and** carry the same Origin
  (or `Sec-Fetch-Site: same-origin`), **with or without a cookie**, else 403 `forbidden`. The
  cookie rule alone does not cover these routes: a signed-out browser (or a `SameSite=Lax`
  cookie on a cross-site POST) carries no cookie, and better-auth checks origins only when a
  cookie is present. Without it a hidden auto-submitted form on any site could sign the
  visitor into the attacker's account (the next «Iniciar sesión» in the app would then offer
  to connect the victim's computer to it) or make many visitors' browsers spend the sign-in
  email caps. A plain HTML form can only send urlencoded, multipart or `text/plain` bodies,
  never JSON, and a cross-site `fetch` with JSON needs a CORS preflight we refuse. The pages
  post JSON with `fetch`, which sends our Origin.
- **Form bodies:** the only urlencoded parser is registered on `POST /v1/app-auth/authorize`
  alone (the «Conectar» button, §4.2); every other route answers 400 to a form body.

### 4.2 Desktop login: loopback redirect + PKCE (RFC 8252, RFC 7636)

1. The Electron main process listens on `127.0.0.1:<random port>`, creates `codeVerifier`
   (43–128 chars), `challenge = base64url(sha256(verifier))` and a random `state` (16–128
   chars of `[A-Za-z0-9._~-]`).
2. It opens the system browser at
   `{API}/cuenta/conectar?challenge=…&state=…&port=…&device=<name>`.
3. Not signed in → redirect to `/cuenta?volver=<that URL>` (only relative `/cuenta…` paths are
   accepted as `volver`). The user signs in with Google or an email code and comes back.
4. Signed in → «¿Conectar este ordenador («{device}») a tu cuenta?» with a **Conectar** button.
   The explicit click prevents login CSRF and silent linking. **Connecting needs a recent
   sign-in** (less than 15 minutes, §4.3): with an older browser session the page says «Vuelve a
   iniciar sesión» instead, and its button signs out and goes to `/cuenta?volver=<this page>`,
   which brings the user back after signing in.
5. The button posts a form to `POST /v1/app-auth/authorize` (`challenge`, `state`, `port`,
   `device`; cookie session + Origin check; a bearer token gets 403, a signed-out browser a 303
   back to `/cuenta?volver=…`, a browser whose sign-in is not fresh a 303 back to the connect
   page of step 4, and no code). The server stores a one-time code (32 random bytes, only its
   SHA-256 in `app_auth_codes` with the browser session's sign-in time, valid 60 s) and answers
   `303 Location: http://127.0.0.1:<port>/callback?code=…&state=…`. Only the literal
   `127.0.0.1`, a port 1024–65535 and that fixed path are ever produced (no open redirect).
6. The app checks `state` and calls `POST /v1/app-auth/token` (`AppTokenRequest`, with the
   computer's IANA `timeZone`). The server deletes the code row and reads it in one statement
   (single use), checks expiry, `base64url(sha256(codeVerifier)) === challenge` (timing-safe)
   and that the code's sign-in is at most 15 minutes + 60 s old (so every exchange, including
   one that replaces a connected computer's session, rests on a recent sign-in). Then, in one
   transaction, it inserts a session row in better-auth's format (`createSessionRow`: 32-char
   id and token, 60 days, no IP or user agent, `authenticated_at` = the code's sign-in time, so
   the new session is exactly as fresh as that sign-in), upserts the device on
   `(user_id, install_id)` (logging in again on the same machine reuses the device, so its
   stats are not double-counted, and revokes its previous session) and stores `timeZone` as the
   profile's. At most 10 devices (409 `limit_reached`).
   Response: `AppTokenResponse { token, expiresAt, deviceId, me }`. An unknown, expired or
   already used code, or a wrong verifier, answers 400 `validation_failed` (path `body.code`);
   the code is burnt either way, so a verifier cannot be guessed.
7. The app stores the token with `safeStorage` and sends it as a bearer token from the main
   process only.
8. `POST /v1/app-auth/logout` deletes the calling session (204); the device row and its stats
   stay. `DELETE /v1/devices/:id` removes the device, its stats and its session.

Fallback if a loopback port cannot be opened: better-auth's `device-authorization` plugin
(RFC 8628) — not built now. No `centrate://` deep links (fragile on Linux, another app can
claim the scheme).

### 4.3 Fresh sessions

A session is **fresh** while the sign-in behind it is less than 15 minutes old
(`CLOUD_LIMITS.freshSessionMinutes`; `requireFreshSession` / `isFreshSession` read
`AuthedUser.authenticatedAt`). For a browser session that is its creation (each sign-in makes a
new one); for a desktop session it is the sign-in of the browser session that connected it
(`session.authenticated_at`), never the moment the bearer row was written. Needing a fresh
session, else 403 `reauth_required`:

- `DELETE /v1/me`;
- `POST /v1/sessions/revoke-others` with `includeDevices: true`;
- `DELETE /v1/devices/:id`, except a computer removing its own device;
- `DELETE /v1/sync/days` for all devices or another device's (`?deviceId=` of the caller's
  own device needs none);
- connecting a computer (`POST /v1/app-auth/authorize` and `/cuenta/conectar`, §4.2).

So a session left on a shared or lost computer, however old, can neither delete the account,
sign the owner's computers out and wipe their stats, nor mint a desktop session: a desktop
session is never fresher than the sign-in behind it, and the only way to get a new one is a
recent sign-in. On `reauth_required` the app runs the loopback login again (the browser asks
the user to sign in again when its own sign-in is old) and retries; the web pages sign out and
send the user to `/cuenta?volver=…` to sign in again and come back. Signing out only the other
browsers needs none: the worst an old session left elsewhere can do with it is sign the owner's
browsers out, and the owner's next sign-in and the same button then end that session. Reading
(`GET /v1/me/export`, the device list) needs none either: an `installId` read there grants
nothing, since the token exchange needs a recent sign-in.

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
| `already_decided`      | 409  | Approval already denied, or approved and this is an approval   |
| `payload_too_large`    | 413  |                                                                |
| `coach_refused`        | 422  | The model declined (`stop_reason: refusal`)                    |
| `rate_limited`         | 429  | `retryAfterSeconds` + `Retry-After` header                     |
| `quota_exceeded`       | 429  | Daily AI quota (`resetsAt`)                                    |
| `internal_error`       | 500  |                                                                |
| `not_implemented`      | 501  | Stubs only                                                     |
| `coach_incomplete`     | 502  | The model hit `max_tokens` or returned nothing parseable       |
| `feature_disabled`     | 503  | `feature` + `reason`                                           |
| `database_unavailable` | 503  | Postgres does not answer                                       |
| `coach_unavailable`    | 503  | Anthropic down, overloaded, rate-limited, or account problem   |

### 5.1 Health and account

| Method and path                   | Auth | Request → response                                                     | Owner |
| --------------------------------- | ---- | ---------------------------------------------------------------------- | ----- |
| GET `/health`                     | P    | → `HealthResponse { ok, version, now, db, serverEpoch, capabilities }` | —     |
| GET, POST `/api/auth/*`           | P    | better-auth (Google, email code, sign-out, session)                    | CORE  |
| POST `/v1/app-auth/authorize`     | C, F | form `{challenge, state, port}` → 303 to the loopback (§4.2, §4.3)     | CORE  |
| POST `/v1/app-auth/token`         | P    | `AppTokenRequest` → `AppTokenResponse`                                 | CORE  |
| POST `/v1/app-auth/logout`        | S    | → 204                                                                  | CORE  |
| GET `/v1/me`                      | S    | → `MeResponse { user, profile, sharing, consentUpdatedAt, … }`         | CORE  |
| PATCH `/v1/me`                    | S    | `PatchMeRequest { profile?, sharing? }` → `MeResponse`                 | CORE  |
| GET `/v1/me/export`               | S    | → `CloudExport` as an attachment (`centrate-datos.json`)               | CORE  |
| DELETE `/v1/me`                   | F    | `{ confirm: 'BORRAR' }` → 204, hard delete with cascade                | CORE  |
| GET `/v1/devices`                 | S    | → `DevicesResponse`                                                    | CORE  |
| PATCH `/v1/devices/:id`           | S    | `{ name }` → `CloudDevice`                                             | CORE  |
| DELETE `/v1/devices/:id`          | F    | → 204 (device, its stats and its session); own device: S               | CORE  |
| GET `/v1/sessions`                | S    | → `SessionsResponse { browser: [{ createdAt, expiresAt, current }] }`  | CORE  |
| POST `/v1/sessions/revoke-others` | S    | `{ includeDevices? }` → `{ browser, devices }` (sessions ended)        | CORE  |

`PATCH /v1/me` rules: `displayName` trimmed 1–40 chars without control characters, and once
set it can be changed but not cleared (`null` is 400; `PatchMeRequest` types it as `string`,
and `routes/me.ts` fails to compile if the type and the schema ever accept different bodies);
`timeZone` a valid IANA zone; `dailyGoalMinutes` 15–600 or null. `sharing.ranking: true` needs
`syncStats` on (already or in the same request), else 400; `syncStats: false` also turns
`ranking` off (a database CHECK enforces it). Turning `presence` off deletes the presence row.
Turning `syncStats` off keeps uploaded stats (the app offers «Borrar también los datos subidos»,
which calls `DELETE /v1/sync/days`). Any switch change sets `consentUpdatedAt`. Turning `ranking`
on stores `rankingSince` (kept while it stays on, cleared when it goes off, a CHECK ties the two;
§8.2).

### 5.2 Sync and stats (CORE)

| Method and path                   | Auth | Request → response                                                    |
| --------------------------------- | ---- | --------------------------------------------------------------------- |
| GET `/v1/sync/state?deviceId=`    | S    | → `SyncStateResponse { serverEpoch, deviceId, revs }` (last 400 days) |
| PUT `/v1/sync/days`               | S    | `PutDaysRequest { deviceId, days ≤ 100 }` → `{ accepted, stale }`     |
| DELETE `/v1/sync/days[?deviceId]` | F    | → 204, the caller's cloud stats; only the own device's: S             |
| GET `/v1/stats?from&to`           | S    | → `StatsResponse { days (merged), deviceDays, devices }`, ≤ 400 days  |

`PUT` needs `sharing.syncStats` (403 `consent_required`) and a bearer session bound to
`deviceId` (another device → 403, someone else's → 404). See §7.

### 5.3 Friends, blocks, ranking, presence (SOCIAL)

| Method and path                         | Auth | Request → response                                                       |
| --------------------------------------- | ---- | ------------------------------------------------------------------------ |
| POST `/v1/friends/invites`              | S    | `{ maxUses? }` → `CreateInviteResponse { id, code, url, … }`             |
| GET `/v1/friends/invites`               | S    | → `InvitesResponse` (own active invites, no codes)                       |
| DELETE `/v1/friends/invites/:id`        | S    | → 204                                                                    |
| GET `/v1/friends/invites/:code`         | S    | → `InvitePreviewResponse { inviter: { displayName } }`                   |
| POST `/v1/friends/invites/:code/accept` | S    | → `AcceptInviteResponse { friend }`                                      |
| GET `/v1/friends`                       | S    | → `FriendsResponse`                                                      |
| DELETE `/v1/friends/:userId`            | S    | → 204 (both sides)                                                       |
| GET `/v1/blocks`                        | S    | → `BlocksResponse`                                                       |
| POST `/v1/blocks`                       | S    | `{ userId }` → 204                                                       |
| DELETE `/v1/blocks/:userId`             | S    | → 204 (does not restore the friendship)                                  |
| GET `/v1/ranking?week=YYYY-Www`         | S    | → `RankingResponse` (needs `sharing.ranking`)                            |
| PUT `/v1/presence`                      | S    | `{ state, endsAt, sentAt }` → `{ expiresAt }` (needs `sharing.presence`) |
| DELETE `/v1/presence`                   | S    | → 204                                                                    |
| GET `/v1/friends/presence`              | S    | → `FriendsPresenceResponse` (needs `sharing.presence`)                   |

### 5.4 Accountability (SOCIAL)

| Method and path                               | Auth | Request → response                                                                                                 |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| GET `/v1/partners`                            | S    | → `PartnersResponse` (as owner and as partner)                                                                     |
| POST `/v1/partners`                           | S    | `{ friendId, requireApproval }` → `PartnerLink` (pending)                                                          |
| POST `/v1/partners/:id/accept`                | S    | (partner) → `PartnerLink`                                                                                          |
| PATCH `/v1/partners/:id`                      | S    | (owner) `{ requireApproval }` → `PartnerLink`                                                                      |
| DELETE `/v1/partners/:id`                     | S    | → 204 (removed now) or 200 `PartnerLink` (ends in 24 h)                                                            |
| POST `/v1/accountability/events`              | S    | `PostAccountabilityEventRequest` → 201/200 `{ eventId, approval }` (`eventId: null`: nobody listens, nothing kept) |
| GET `/v1/accountability/events/:id`           | S    | (owner) → `AccountabilityEventResponse`                                                                            |
| GET `/v1/accountability/inbox`                | S    | (partner) → `InboxResponse`                                                                                        |
| POST `/v1/accountability/events/:id/decision` | S    | (partner whose link asks for approval) `{ decision, note }` → `ApprovalState`                                      |

### 5.5 Coach (COACH)

All need the `coach` capability (503 otherwise) and `sharing.coach` (403 `consent_required`),
except `GET /v1/coach/quota`, which needs only the capability.

| Method and path                 | Request → response                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET `/v1/coach/quota`           | → `CoachQuotaResponse { interpret, coach, available, resetsAt }`                                       |
| POST `/v1/coach/interpret`      | `InterpretRequest { text, timeZone, now }` → `{ canonicalText, clarification }`                        |
| POST `/v1/coach/split-task`     | `SplitTaskRequest` → `SplitTaskResponse { steps (2–12), firstStepTip }`                                |
| POST `/v1/coach/study-plan`     | `StudyPlanRequest` → `StudyPlanResponse { days, advice, coversUntil, truncated }` (≤ 28 calendar days) |
| POST `/v1/coach/weekly-summary` | `WeeklySummaryRequest { week, stats }` → `{ headline, highlights, suggestion }`                        |

### 5.6 Pages (HTML, §11)

`/cuenta` · `/cuenta/codigo` · `/cuenta/conectar` · `/cuenta/assets/:name` (CORE) ·
`/cuenta/panel` · `/cuenta/avisos` (CLIENT) · `/i/:code` (SOCIAL).

## 6. Database

Postgres through Drizzle (`src/db/schema.ts`), 20 tables. Conventions: `timestamptz`
everywhere; `day` columns are `date` holding the civil date of whoever produced the number
(never converted to UTC); app ids are `uuid` (`gen_random_uuid()`), user ids are better-auth's
text ids; **every foreign key to `user` cascades**, so deleting the user row erases everything
about them (the one exception is `accountability_events.decided_by`, set null).

| Table                   | Key                                   | Holds                                                                                                     |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `user`                  | `id`                                  | better-auth: email, verified flag. `name` never shown, `image` null                                       |
| `session`               | `id`, unique `token`                  | better-auth; `token` is also the bearer token. IP and UA null; `authenticated_at` (§4.3)                  |
| `account`               | `id`                                  | better-auth: provider links (Google tokens encrypted)                                                     |
| `verification`          | `id`                                  | better-auth: email codes                                                                                  |
| `profiles`              | `user_id`                             | display name, time zone, daily goal, five sharing switches, consent time                                  |
| `devices`               | `id`, unique `(user_id, install_id)`  | connected computers, bound `session_id`, `last_sync_at`                                                   |
| `app_auth_codes`        | `code_hash`                           | loopback login codes (hash, challenge, port, sign-in time, 60 s)                                          |
| `daily_stats`           | `(device_id, day)`                    | numbers only (§7). CHECKs: minutes 0–1440, study ≤ focus, counters 0–10 000, points 0–100 000             |
| `friend_invites`        | `id`, unique `code_hash`              | invite hashes, uses, expiry                                                                               |
| `friendships`           | `(user_id, friend_id)`                | two symmetric rows per friendship                                                                         |
| `user_blocks`           | `(blocker_id, blocked_id)`            |                                                                                                           |
| `presence`              | `user_id`                             | state, since, endsAt, expiresAt                                                                           |
| `partner_links`         | `id`, unique `(owner_id, partner_id)` | status, requireApproval, approvalOffAt, endsAt                                                            |
| `accountability_events` | `id`, unique `(owner_id, client_ref)` | kind, times, approval status/deadline/decider/note (≤ 140)                                                |
| `usage_counters`        | `(user_id, day, key)`                 | small daily counters (`partner_email`)                                                                    |
| `rate_counters`         | `(key, window_start)`                 | durable counters not tied to an account (sign-in emails, HMAC keys, no addresses; partner emails, global) |
| `ai_usage`              | `(user_id, day, feature)`             | requests, reserved/used tokens, cost. **No text**                                                         |
| `ai_identity_daily`     | `(day, identity_hmac, feature)`       | the day's AI requests, tokens, cost per mailbox (HMAC key, no FK: outlives the account)                   |
| `ai_global_daily`       | `day`                                 | global requests, cost, reserved cost                                                                      |
| `meta`                  | `key`                                 | `server_epoch`, `janitor_last_run`                                                                        |

**Migrations.** `npm run db:generate -w apps/api` writes SQL to `apps/api/drizzle/` (commit it,
the script runs prettier on `drizzle/meta/*.json`, which CI checks). The server applies migrations at boot under a
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
| `rate_counters`                             | past `expires_at` (end of the window, ≤ 1 day)   |
| `ai_usage`, `ai_global_daily`               | after 90 days                                    |
| AI quota holds of calls whose process died  | freed 10 min after `reserved_until` (§10.2)      |
| `ai_identity_daily`                         | once its UTC day is over (first sweep after)     |
| `daily_stats`                               | days older than 2 years                          |
| `user.name`                                 | emptied once the profile exists (§4.1)           |

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
- **Re-upload on every sign-in.** A sign-out or a 401 empties the outbox, while the device row
  and its stats stay (§4.2). So after each login the app reads
  `GET /v1/sync/state?deviceId=` and queues `daysToReupload(localDays, state, now)`: the days
  the server lacks or holds at the **same or a lower** `rev`. An equal `rev` goes too, because a
  running block grows a day's minutes without a new guardian event (a block that crossed
  midnight closes the day at the same `rev` with more minutes), and the server lets an equal
  `rev` overwrite, idempotently. Only days from `syncWindowStart(now)` on go (the 400-day window
  with one day of margin, as the server's «today» is within a day of the UTC date): older local
  days stay on the computer instead of coming back as a 400, so years of local history still
  make at most four requests of 100.
- **Database replaced:** the free Postgres expires (§15) and a new one is empty. Everything in
  it is gone: better-auth's users, sessions and Google links, our devices, profiles and
  **sharing choices**, stats, friendships, invites, blocks and partner links. So the old token
  gets 401 everywhere (`GET /v1/sync/state` included), and the only thing that tells the app
  why is the public `serverEpoch`. The sequence:
  1. The app remembers the last `serverEpoch` it saw (only a string; a `null` never overwrites
     it), plus the sharing choices, display name, time zone and goal the user last set
     (locally, never only in the cloud).
  2. At start (and before treating a 401 as a plain sign-out) it reads `GET /health` and asks
     `cloudWasReset(rememberedEpoch, health)`. It is true only when the database answers
     (`db: 'up'`) with a `serverEpoch` that differs from the remembered one. A `null` epoch
     (database unconfigured, down, or its probe failed: a free database in its grace period,
     a brief outage) means «unknown», never «changed»: keep the token, the device id and the
     outbox, and try again later. A proven reset drops the token, the device id and the outbox
     (stats are rebuilt from the guardian log in step 4; queued partner events have no partner
     any more), **keeps all local data**, and shows «La nube se ha reiniciado: vuelve a
     conectar». Friends and partners are gone; the app says so.
  3. The user connects again (§4.2 loopback login). That creates a new account and device with
     every switch off. The app shows the remembered choices and, once the user confirms,
     re-applies them with `PATCH /v1/me` (profile and `sharing`, at least `syncStats` for step
     4). Consent is never restored silently.
  4. The usual re-upload after a sign-in (above): `GET /v1/sync/state?deviceId=<new id>` and
     `daysToReupload(localDays, state, now)` (every local day of the window, as the new
     database holds none); the result goes through the outbox in batches of 100.
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
- **Never retroactive.** A friend's days count only from the civil day (in that friend's zone)
  of the latest of: the friendship's `created_at`, the friend's `rankingSince` and the
  caller's `rankingSince` (when each last turned the ranking on). So a new friend, or someone
  who just turned the ranking on, never sees earlier weeks, and the pair see each other over
  the same days. A friend whose first counted day is after the week is not in that week's
  entries at all (rather than a misleading 0). Granularity is the day: the first day counts
  whole. The caller's own entry keeps its full history. Unfriending (or a block) and
  befriending again starts over.
- Per user and day: `SUM(focus_minutes)` across devices capped at 1440 (study capped at
  focus). `activeDays` = days with focus > 0; `goalDays` = days meeting that person's own goal.
  `day` values are each user's civil dates, so everyone is compared Monday–Sunday in their own
  zone.
- Order: focus minutes desc, active days desc, display name (`es` collation), user id.
  Competition ranking on (minutes, active days): 1, 2, 2, 4.
- Points are not shared (they can be negative and are more personal).

### 8.3 «Estudiando ahora»

- `PUT /v1/presence` (needs `sharing.presence`) upserts `expires_at = now + 180 s`; `since` is
  kept while the state is unchanged and the row alive, else reset to now. The app sends a
  heartbeat every 60 s during a block or study session and `DELETE` when it ends; a crash
  disappears within 3 minutes.
- **The app's clock is not trusted** (as for events, §9). Every heartbeat carries `sentAt`, the
  app's clock when sending (the client's `putPresence` sets it on each call), and the server
  only uses `endsAt − sentAt`: the stored end is `now + (endsAt − sentAt)` on the server's
  clock. So a slow computer is not refused for a block about to end, and a fast one does not
  shift the end friends see. `endsAt` must be after `sentAt` (else 400) or null; more than 24 h
  left (a clock stepped back during a block; the guardian's longest block is 24 h) is clamped
  to 24 h, not refused.
- Readers see only rows with `expires_at > now` (no dependence on the janitor), of friends who
  share presence, and only if the reader shares too. Friends see state, since, `endsAt` (the
  server's clock, for display) and `endsInSeconds` (time left when the server answered):
  never what is blocked or the task.
- «Estudiar juntos» is a desktop feature on top of this: «Unirme» creates a local session
  ending `endsInSeconds` after the answer on the app's own clock (not at `endsAt`, which a
  wrong clock would shift); the user confirms locally. No server state.
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
  (16–64 chars). `(owner_id, client_ref)` is unique: a replay returns the stored event with 200
  (a new one is 201). No reason, domain, task or note from the owner is accepted. The app needs
  the answer to an `emergency_requested` at once (its `eventId` and `approval`), so it sends
  that one **directly** with `sendAccountabilityEvent` (`cloud-api.ts`): the client wakes a
  sleeping server first («Despertando el servidor…»), then posts it. Only a failure that a
  resend can fix (offline, a timeout, a 5xx) puts it in the offline outbox, which replays the
  same `clientRef` later and hands the answer to `onEventSent`; if the first request did reach
  the server, the replay answers that stored event, so the `eventId` is never lost. The other
  kinds go straight to the outbox (`addEvent`).
- **The owner's clock is not trusted.** A computer clock can be minutes or hours off, so every
  request carries `sentAt` (the app's clock when sending; the client sets it on each attempt)
  and the server only uses differences on that one clock: the event happened
  `sentAt − occurredAt` ago (0 to 7 days; up to 5 min negative is read as 0, a clock stepped
  back in between) and the countdown has `countdownEndsAt − sentAt` left. Both are placed on
  the server's clock when the request arrives, so a fast clock is not rejected, a slow one does
  not hide the event behind `acceptedAt`, and an approval deadline never outlasts the real
  countdown. Only the request's travel time is unaccounted for; the 30 s margin below absorbs
  it. The client wakes a sleeping server before it stamps `sentAt`, so a cold start is not
  travel time; a request held past the app's 10 s timeout anyway already counts as approved on
  the app (step 4) until an answer arrives. A clock changed between the event and its sending
  shifts that one event.
- **Only kept while someone listens.** An event no partner hears about (no partner, only
  pending ones, or all accepted after the event) is not stored at all: the answer is 200
  `{ eventId: null, approval: null }` and the outbox drops it as sent. A replay stays harmless:
  a partner who accepts later never hears about an earlier event.
- **Who hears:** partners of active (or ending) links accepted before the event. The inbox
  (`GET /v1/accountability/inbox`) lists their owners' events of the last 30 days, newest first
  (≤ 100), each with `canDecide` (the caller may still answer it: see step 5 below). Email
  (Resend) only when the partner turned `partnerEmails` on, only for `emergency_requested`,
  `emergency_confirmed` and `study_abandoned`, at most 10 per partner per day
  (`usage_counters.partner_email`) and `PARTNER_EMAILS_PER_DAY_GLOBAL` (40) for everybody per
  UTC day (`rate_counters`, key `partner_email:global`; proposal emails count too). The global
  cap exists because sign-in codes share the Resend plan (free: about 100 a day): keep
  `SIGNIN_EMAILS_PER_DAY` + `PARTNER_EMAILS_PER_DAY_GLOBAL` under the plan's daily quota, so a
  group of friends posting alerts can never use up the room for sign-in codes. A spent global
  cap is checked first and does not use up a partner's own allowance; a partner past their own
  10 does not spend the global cap. Past it, alerts reach the inbox only. Emails are minimal
  Spanish text, times in the partner's zone: «Dani ha pedido el desbloqueo de emergencia
  (18:40)». With a pending approval, partners who can answer it get «Puedes aprobarlo o
  rechazarlo hasta las 18:55 en Céntrate o en {URL}/cuenta/avisos». Never a reason, domain,
  task or points. They go out in the background, one message at a time for the whole process
  (Resend limits requests per second), and a message refused with 429 is retried once after
  its `Retry-After` (1 s without one) when that is at most 5 s; a longer wait means a spent
  daily or monthly quota, and it is dropped (logged by type only).

### Approval flow (never blocks the guardian)

1. Only for `emergency_requested` whose countdown leaves the partner at least 60 s after the
   margin (`countdownEndsAt − sentAt ≥ 90 s`), when the owner has at least one active link with
   approval effectively on. Else `approval: null`.
2. `deadline = now + min(countdownEndsAt − sentAt − 30 s, 30 min)` (`approvalMarginSeconds`):
   the approval never adds waiting time on top of the guardian's own local countdown, which
   keeps running unchanged, and it closes 30 s before that countdown ends (travel time plus one
   poll), so the app reads the last answer before the confirm button appears. The deadline is
   on the server's clock and is only shown to partners («hasta las 18:55»).
3. The `eventId` to poll comes from the answer: `sendAccountabilityEvent` returns it when the
   event went out directly (`status: 'sent'`); when it was queued (`status: 'queued'`), the
   app has nothing to wait for (fail open) until the outbox delivers it and `onEventSent`
   reports the answer. While `approval.status` is `pending` or `approved` and the local
   countdown still runs, the app polls `GET /v1/accountability/events/:id` every 15 s (an
   approval is not final: a denial still replaces it until the deadline, step 5). `expired` is
   computed on read (pending past its deadline). `approvalOutcome(approval, now,
countdownEndsAt)` decides with the app's own countdown, never by comparing the server's
   deadline with the app's clock: `wait` while the last answer is `pending` or `approved` and
   the countdown runs.
4. **Approved** → the usual confirm button at the end of the countdown (approval never
   shortens it; the app may show «Ana lo ha aprobado» meanwhile). **Denied** → the app shows «Tu compañero ha dicho que no» and cancels _this_
   emergency request through the guardian's existing cancel endpoint; the block stays. The user
   may ask again after a local 15-minute cooldown (a new request, a new approval).
   **Expired, 5xx, timeout or offline** → treated as approved (fail open); the partner later
   sees «no respondió».
5. Decisions: only a partner with an active link to the owner that effectively asks for
   approval (`requireApproval` on, or its switch-off still in its 24 h); a partner who is only
   told gets 403 `forbidden` and sees the outcome. **A denial wins:** an approval moves
   `pending → approved`; a denial moves `pending` or `approved → denied` until the deadline
   (`UPDATE … WHERE approval_status IN ('pending', 'approved') AND approval_deadline > now`),
   and nothing replaces a denial. The owner can add a partner at once (strengthening), even
   an account they control; since an approval never shortens the countdown, such a partner's
   quick «sí» cannot lock out a stricter partner's «no». After the deadline 409
   `deadline_passed`; a second approval or anything after a denial 409 `already_decided`; the
   same partner repeating the same answer (a retry) 200. The last decider's note ≤ 140 chars
   is shown to the owner; the inbox's `canDecide` is true while the caller can still answer
   (approve or deny while `pending`, deny while `approved`).

Hardcore and Exam modes have no emergency unlock, so they never reach this flow.

## 10. Coach (COACH, Claude API)

The Anthropic key lives only in the backend environment. Model choice and SDK usage follow the
`claude-api` skill (2026-09). Code: `src/routes/coach.ts` and `src/coach/` (`model.ts` seam,
`anthropic.ts` client, `prompts.ts`, `schemas.ts`, `endpoints.ts` settings and worst cases,
`service.ts` gates and call flow, `quota.ts`, `budget.ts`, one module per endpoint, `text.ts`
hygiene).

| Endpoint         | Model (env override)                      | Settings                                                            | `max_tokens` | Deadline |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------- | ------------ | -------- |
| `interpret`      | `claude-haiku-4-5` (`AI_MODEL_INTERPRET`) | no thinking, no effort (Haiku 4.5 rejects it), `temperature: 0`     | 1024         | 20 s     |
| `split-task`     | `claude-opus-5` (`AI_MODEL_COACH`)        | adaptive thinking (Opus 5's default: omit `thinking`), effort `low` | 4000         | 60 s     |
| `study-plan`     | `claude-opus-5`                           | effort `low`, at most 28 days per plan (`studyPlanMaxDays`)         | 8000         | 80 s     |
| `weekly-summary` | `claude-opus-5`                           | effort `low`                                                        | 4000         | 45 s     |

- **One client** (`createAnthropicCoachModel`, wired as the default `coachModel` in `buildApp`):
  created only when the key is set and `AI_ENABLED` is true, with every option explicit
  (`apiKey`, `authToken: null`, `baseURL`, `logLevel: 'off'`, `maxRetries: 0`) so no stray
  `ANTHROPIC_*` variable changes where the key goes or what gets logged. Each call carries its
  deadline as both the SDK `timeout` and an `AbortSignal`, so the retry never outlives it (the
  app wakes a sleeping server first, then waits 100 s for the coach answer, §14). Tests inject
  a fake behind the `CoachModel` seam.
- **Streaming**: every call goes through `client.beta.messages.stream(params, { signal })`
  (the beta namespace is needed for fallbacks) and `finalMessage()`. The adapter watches the
  events as they arrive: `message_start` (the serving model and its input usage), a `fallback`
  content block (a second model took over) and `message_delta` (the final usage). So a call
  cut off half way (our deadline, a reset connection, an `error` event) still says what it may
  have cost (§10.2).
- **Structured outputs**: `output_config.format` from `betaZodOutputFormat(schema)`, sent
  without its `parse` function so the SDK leaves the text alone; we parse it with the same zod
  schema **after** checking `stop_reason` (the SDK's own parsing throws on truncated JSON
  before the usage can be read, and a truncated answer must still be billed). Model schemas
  hold only types and enums (the API cannot enforce lengths or ranges); the server clamps
  lengths, counts and minutes afterwards.
- **Refusal fallbacks**: SDK 0.128 supports them. Requests to `claude-opus-5` (and
  `claude-fable-5-1`) send `betas: ['server-side-fallback-2026-07-01']` and
  `fallbacks: 'default'`: a request the model declines may be answered by the fallback model
  Anthropic picks for that refusal category (Opus 4.8 for cyber). Other model ids run without
  it. Every attempt in `usage.iterations` is billed at its own model's price.
  `AI_REFUSAL_FALLBACKS=false` sends neither the beta nor `fallbacks` (and the worst case drops
  the fallback hop, §10.2): the owner's lever, without a code change, if the API stops taking
  that beta header (every Opus call would then fail with a 400 and the breaker, §10.3, would
  switch the coach off).
- **Always check `stop_reason`** before reading output: `refusal` (the whole chain declined) →
  422 `coach_refused`; `max_tokens`, any other stop, unparseable JSON, a schema mismatch or an
  answer that fails the server checks (for example fewer than 2 steps) → 502
  `coach_incomplete`. Both are billed.
- **SDK errors**, most specific first: the owner's account or settings, 401/403, 402
  (`billing_error`: no credit; no SDK class, matched by status and error type) and 404 (a
  retired or mistyped `AI_MODEL_*`, or one the key cannot use), and the same types as `error`
  events → 503 `coach_unavailable` plus an error log (`misconfigured`, class name and status
  only); 429, 5xx, 529 overloaded, 408/409, timeouts, network errors, other `error` events in
  the stream and our deadline → 503 `coach_unavailable` (warn log); other 4xx → 500
  `internal_error` (`rejected`), logged by class only. That includes the account-level 400s
  (credit balance too low, the Console's monthly usage limit reached) and a beta header the API
  no longer takes: only the provider's message tells them from our own bug, and it is never
  read. The breaker (§10.3) turns all of these into «coach off» after a few. The provider's
  message is never logged or returned (it can quote the key or the input).
- **One retry, only when certainly unbilled**: the SDK's own retries are off (they would also
  repeat attempts that may have been billed). The adapter retries once, inside the deadline
  and after `retry-after` (at most 5 s), an HTTP 408/409/429/5xx/529 answered instead of the
  event stream, an overloaded or rate-limit `error` event before `message_start`, and a
  connection that never left (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH,
  connect timeout). Nothing else is retried.
- **Prompt caching**: each endpoint has one frozen Spanish system prompt with
  `cache_control: { type: 'ephemeral' }` (deterministic: no dates, ids or unsorted data).
  Everything variable goes in the user message, the user's text wrapped in
  `<datos_usuario>…</datos_usuario>` as one line with `<` `>` replaced by `‹` `›`, so it can
  never close the wrapper, and treated as data, never instructions. The Opus prompts pass
  Opus 5's 512-token minimum; the interpret prompt (with the catalog) is about 3 000 tokens,
  under Haiku 4.5's 4 096, so it silently does not cache. Padding it would make every
  uncached call dearer, and calls are rare. Tests check the request shape.
- **`metadata.user_id`** = first 32 hex chars of HMAC-SHA256(`BETTER_AUTH_SECRET`,
  `anthropic:` + userId). Never the id or email.
- **Model overrides are safe**: `temperature` is only sent to Haiku models, `effort` never to
  Haiku or Sonnet 4.5, `fallbacks` only to the models above.
- **Tone**: Spanish (Spain), sentence case, typographic «−» (the server also rewrites `-5` to
  `−5` in answers), encouraging, never shaming, no emojis. If the text suggests distress, the
  answer is kind and mentions the 024 line (Spain).
- **Nothing the model returns is executed**; every output is validated again on the server.
- **Logs**: one `coach call` line per call (endpoint, served model, outcome, `billing`,
  attempts, token counts, cost in micro-USD booked, time). Never the prompt, the answer or the
  user id.

### 10.1 Endpoint behaviour

Order of checks on every POST: capability (503) → session (401) → `sharing.coach` (403) →
breaker and database kill switch (503 `kill_switch`) → body (400) → one call in flight (429
`rate_limited`), quotas and spend cap (429 `quota_exceeded`), global budget (429
`rate_limited` while calls in flight hold it, 503 `budget` once settled spend leaves no room)
→ model.
Nothing is reserved for a request that fails validation.

- **interpret** runs only when the user taps «Preguntar al coach» under «No he entendido: …»,
  or turned on «Usar IA cuando no entienda la frase» in the app. `now` must be within 24 h of
  the server clock. The model gets the phrase, the user's local date and time and the catalog
  (service ids with names and common forms, category ids), and returns a structured intent:
  `kind` (`block` / `study` / `unclear`), `serviceIds` and `categoryIds` (enums of catalog ids,
  so an invented service is impossible), `domains`, `durationMinutes`, `untilTime` («HH:MM»)
  with `untilTomorrow`, `task`, `clarification`. **The server writes `canonicalText` itself**
  («bloquear youtube y instagram durante 75 minutos», «estudiar física durante 40 minutos»),
  using for each id a word the local parser is known to read as exactly that id (built once
  from the catalog; 88 of 90 services, all categories; `juegos-com` and `minijuegos-com` read
  as the Juegos category, so they are dropped). Durations are clamped to 5–1440 minutes; a
  domain is kept only if the user typed it; at most 10 targets. The phrase is accepted only if
  the shared `parseIntent` reads it back to the same kind and targets with nothing unparsed
  and a duration within 5–1440, using a clock shifted so `now.getHours()` reads the user's wall
  time in `timeZone` (the parser reads local time; the server runs in UTC). Otherwise
  `canonicalText: null` and the model's clarification (for `unclear`) or a generic Spanish one.
  The **desktop re-parses `canonicalText` locally** (correct zone) and always shows the
  confirmation card; nothing goes straight to a block.
- **split-task**: 2–12 steps (extra steps dropped; fewer → 502), titles ≤ 80, minutes clamped
  to 5–120, tip ≤ 200. A `suggestedPhrase` survives only if `parseIntent` reads it with
  `complete: true`, nothing unparsed, no domains and exactly the step's minutes; else null.
- **study-plan**: `today` within a day of the server's UTC date, `examDate` 1–366 days after
  it, at least one study day left (400 otherwise). The server computes the study days
  (`[today, examDate − 1]`, at most `CLOUD_LIMITS.studyPlanMaxDays` = 28 calendar days, minus
  `daysOff`; a later exam gets a plan for the first four weeks and the prompt says so) and
  gives the model that exact list; it then keeps only listed days, once each, in order, at most
  6 items a day of at least 5 minutes, scales each day down to `dailyMinutes` (dropping the
  last items if still over), keeps topics ≤ 80 chars and advice ≤ 5 items of ≤ 200. The answer
  says how far the plan goes: `coversUntil` is the last calendar day of the window (the day
  before the exam, or `today + 27`), and `truncated` is true when that is before the day before
  the exam. The app then says «Este plan llega hasta el …; pide el resto más adelante» and asks
  again, with a later `today`, when the plan runs out. The constant lives in `cloud-api.ts` and
  `src/coach/study-plan.ts` imports it, so the app and the server cannot disagree.
- **weekly-summary**: the week must be a valid ISO week that has started in the profile's
  zone. With `syncStats` on, the input is built on the server from `daily_stats` (the week,
  summed across devices with focus capped at 1440 and study at focus, plus the previous 3
  weeks' totals; numbers only, `stats` ignored); otherwise `stats` is required, its days must
  fall inside the week, and it is processed, not stored. No user text reaches this prompt. No
  summary text is stored (the app caches its own). Headline ≤ 120, ≤ 4 highlights of ≤ 160,
  suggestion ≤ 240.
- **quota** (`GET /v1/coach/quota`, capability only, runtime switches included: 503
  `kill_switch` while the breaker or `meta.ai_kill_switch` is on): requests left per bucket and
  `tokensLeft` = `AI_USER_DAILY_TOKENS` − (used + reserved), both counting the larger of the
  account's and the mailbox's use (§10.2), `resetsAt` = next 00:00 UTC, and `available`
  (`interpret`, `splitTask`, `studyPlan`, `weeklySummary`): whether that call's **largest**
  request would be admitted once the calls in flight end (a request left in its bucket, room
  under the token and spend caps for its first hop, room in today's **settled** global spend
  for its whole worst case, and a configuration that lets it run at all). A study plan needs
  more room than a phrase, so `studyPlan` can be false with requests left, or while the day's
  global spend still leaves room for a split task: the app disables that action instead of
  promising requests it would refuse. `false` means 429 `quota_exceeded` or 503 `budget` until
  `resetsAt` (or 503 `budget` every day for a configuration that never allows it). Each
  endpoint's largest request is bounded by `maxUserChars` (`src/coach/endpoints.ts`); a test
  builds the largest valid request of each and checks it.

### 10.2 Quotas, budget and kill switch

- Per user (and per mailbox, below) per UTC day: `interpret` requests, `coach` requests
  (split-task, study-plan, weekly-summary), tokens (input + output + cache reads + cache
  writes, both buckets together) and spend (`AI_USER_DAILY_BUDGET_USD`, both buckets together,
  never above the global budget). Global: spend per UTC day against
  `AI_GLOBAL_DAILY_BUDGET_USD`.
- **Worst case of a call** (`worstCaseAttempts` in `src/coach/budget.ts`, `worstCaseOf` in
  `src/coach/endpoints.ts`): estimated input (characters / 3 + 1 500 for the schema and
  framing), all of it priced as cache writes, plus `max_tokens` of output (the **first hop**);
  for models sent with `fallbacks: 'default'` a speculative second hop on the dearest of the
  model and its documented fallbacks (Opus 4.8 for Opus 5), reading up to `max_tokens` of
  declined partial answer as extra input and writing its own `max_tokens`. Largest requests
  with the defaults, first hop / whole: interpret ≈ 0.011 / 0.011 USD, split-task and
  weekly-summary ≈ 0.12 / 0.26, study-plan ≈ 0.22 / 0.49.
- **The user's caps check the first hop; the reservation holds the whole.** The fallback hop
  only runs after a refusal and settle books what it really cost, so checking it against the
  user's caps would only refuse ordinary days: with it, one split task (≈ 0.045 USD) left no
  room under 0.50 USD for a study plan. So a call is admitted when settled + held + its first
  hop fits the user's token and spend caps, while its whole worst case is held on the user's
  row and in the global budget (spent + held + whole ≤ budget) until it settles. One call can
  take a user past the cap by at most its own fallback hop, and only when a refusal made it
  run; the next call then no longer fits.
- **Per mailbox, not only per account.** Deleting the account (`DELETE /v1/me`) and signing
  up again with the same address, or a second account on `ana+1@…` / `a.na@gmail.com`, must not
  reset the day. `ai_identity_daily` counts the day's requests, tokens and cost per mailbox,
  keyed by HMAC-SHA256(`BETTER_AUTH_SECRET`, `ai:` + the normalised address:
  `normalizeMailbox`, the same rules as the sign-in email limits), with no foreign key to
  `user`, so it survives the deletion; reserve and settle update it next to `ai_usage`, and
  each limit is checked against the larger of the account's and the mailbox's use. It holds no
  address, no account id and no text, and the janitor deletes each row once its UTC day is
  over (so under 48 h). Google sign-ups are stored under their Google address, so the same
  Google account maps to the same mailbox.
- **Reserve, call, settle** (`src/coach/quota.ts`). Before calling, one transaction takes a
  per-user and then a per-mailbox advisory lock (`pg_advisory_xact_lock`: the limits span both
  buckets and every account on the mailbox, so a row lock is not enough) and checks, in order:
  1. **One call in flight per user and bucket.** The row's `reserved_until` (deadline + 30 s)
     still ahead → 429 `rate_limited` with `retryAfterSeconds` until then. So one account can
     never hold more than one worst-case reservation per bucket.
  2. **Requests**, then **tokens and spend**: used (or spent) + held + this call's first hop,
     each counting the larger of the account's and the mailbox's use, against the limits →
     429 `quota_exceeded` with `resetsAt` (the next 00:00 UTC). If the call would fit once the
     user's call in the other bucket settles, 429 `rate_limited` instead (retryable).
  3. **Global budget**: a conditional upsert on `ai_global_daily`, applied only while
     `cost + reserved + $c ≤ budget` (the whole worst case is held, so the day's spend never
     passes the budget). When it does not apply, only settled spend decides the answer: if
     `cost + $c ≤ budget` the room is only held by calls in flight, which give it back within
     their deadlines → 429 `rate_limited`, `retryAfterSeconds` until the first hold still in
     flight ends, at most 30 s (retryable for the app client); otherwise → 503
     `feature_disabled`, `reason: 'budget'`, which the app reads as «spent until 00:00 UTC»
     and which then holds for this call until then (settled spend only grows). A call whose
     first hop alone exceeds the per-user cap, or whose whole worst case exceeds the global
     budget, can never run: 503 `budget` as well.
  4. The request, the whole worst-case tokens and cost and `reserved_until` go on the user
     row; the request on the mailbox row. Settle then books the real (or bounded) tokens and
     cost on the budget row, the user row and the mailbox row, locking them in that order (the
     reservation's and the janitor's order, so they never deadlock).
- **What a call books** (`CoachBilling` in `src/coach/model.ts`; the log line's `billing`
  says which: `exact`, `none` or `bound`). After the call the reservation is replaced by what
  the provider billed or may have billed; the request stays counted, except when the provider
  certainly did not run the call:
  - an answer (ok, refused or incomplete), or a failure after `message_delta`: the real usage
    of every attempt in `usage.iterations`;
  - certainly not billed: an HTTP error status (any 4xx or 5xx, 529 included) answered
    instead of the event stream (the request failed before streaming began, so no token was
    generated; failures after the 200 arrive as `error` events), a rejection, rate-limit or
    overloaded `error` event before `message_start`, a connection that never left: nothing,
    and the request is given back on the user's, the mailbox's and the budget's rows
    (`release`). An Anthropic outage, a spent credit or a retired model is not the user's use
    of the day; the route's rate limit (10 a minute), the one call in flight and the breaker
    stop hammering;
  - sent but the final usage never arrived (our deadline, an SDK timeout, a connection reset,
    a body cut off, an `error` event after `message_start`): an upper bound, every model
    that may have run with `max_tokens` of output — the requested one with the input that
    `message_start` reported (or the estimate), a pre-output decline (a `message_start` naming
    another model) at its input, and the model of each `fallback` block at its worst case;
  - anything unexpected: the whole reservation.
- A reservation that never settles (the process died mid-call) stops blocking the user once
  `reserved_until` passes, and the janitor frees its hold (§6) 10 minutes after that at the
  earliest and about an hour at most: the user's row gives it back (the request stays counted;
  a call our process lost is not the user's spending), the global budget books it as spent
  (what the provider billed is unknown, so the money side keeps the upper bound). A graceful
  shutdown never loses a call: SIGTERM waits for it (§15). A late
  settle only frees its own amounts. `/health` reports `coach: budget` from **settled** spend
  only, so reservations in flight (gone within `deadline + 30 s`) never switch the coach off
  for everyone; while they fill the budget, new calls get 429 `rate_limited` (retryable), not
  503 `budget`. With the defaults four study plans in flight hold about 1.99 USD of 2; four
  accounts doing that on purpose only make the others wait and retry (each account can keep
  one call in flight at a time, 10 a day), and four accounts can spend the whole budget anyway
  (each may spend 0.50 USD). Holding only the first hop globally was
  rejected: every call in flight could then run its fallback hop past the budget, and a
  refusal, which is what triggers that hop, can be provoked from the user's text.
- Tested: 20 parallel reservations for one user give exactly one (the rest `busy`), then the
  request limit holds exactly; a second call while the first runs → 429 `rate_limited`; the
  per-user cap spans both buckets and leaves other users alone; busy vs quota; lost
  reservations; after an ordinary split task two study plans still run and the quota says when
  a third will not; the whole worst case is held while only the first hop is capped; deleting
  the account and signing up again with the same mailbox (or a `+tag` / Gmail-dots spelling of
  it) keeps the day's use, and two live accounts on one mailbox share one cap; booking of failed
  calls through the real SDK against a fake SSE server (500/502/503 before the stream: nothing
  and one retry; a stream cut before and after `message_start`; deadline with a `fallback`
  block); unbilled failures give the request back; four study plans in flight → 429
  `rate_limited` with the wait until the first hold ends, not 503, and room again once one
  settles; settled spend with room for a split task only → study plan 503 `budget`, the quota
  says `studyPlan: false`, `/health` keeps the coach on; 402, 404 and a `billing_error` event
  → 503 `coach_unavailable`, request back, and the third opens the breaker;
  `AI_REFUSAL_FALLBACKS=false` sends no beta and holds one hop.
- Why 0.5 USD per user (25 % of the default budget): every endpoint's first hop must fit on its
  own, with room for an ordinary day next to it (a study plan's largest first hop is about
  0.22 USD, so about three plans a day, or many more smaller calls). With the defaults one
  account can spend about a quarter of the day's budget (plus, after a refusal, one fallback
  hop) and hold at most one reservation per bucket at a time. Raise
  `AI_GLOBAL_DAILY_BUDGET_USD` and keep the per-user cap to lower that share.
- **Settings that keep an endpoint from ever running** are logged as warnings at boot and by
  `node dist/server.mjs --check` (`coachConfigWarnings` in `src/coach/endpoints.ts`, next to
  the environment's own warnings): a largest first hop above `AI_USER_DAILY_BUDGET_USD` (about
  0.22 USD for a study plan) or `AI_USER_DAILY_TOKENS` (about 11 600 tokens), a largest whole
  worst case above `AI_GLOBAL_DAILY_BUDGET_USD` (about 0.49 USD), and a model id without a
  price (billed at the dearest listed rate). Such an endpoint answers 503 `budget` (or 429
  `quota_exceeded` for tokens) every time and GET `/v1/coach/quota` reports it
  `available: false`; the others keep working. The token limit stays at 150 000: interpret
  volume (about 4 500 tokens a phrase) is what it bounds; the spend cap bounds the Opus calls.
- **Prices** (micro-USD per token, `MODEL_PRICES` in `src/coach/budget.ts`, skill 2026-09):
  `claude-haiku-4-5` 1 / 5, `claude-sonnet-5` 2 / 10, `claude-opus-5` 5 / 25, `claude-opus-4-8`
  5 / 25, `claude-opus-5-5` 4 / 20, `claude-fable-5-1` 10 / 50, …; cache writes 1.25× input,
  cache reads 0.1× input. An unknown model id is billed at the most expensive listed rate
  (conservative).
- **Kill switches**:
  - **The one to use: `AI_ENABLED=false`.** Render → `centrate-api` → Environment → set
    `AI_ENABLED` to `false` → **Save and deploy** (no rebuild; the coach is off in about 1–2
    minutes, when the new instance takes over). render.yaml declares `AI_ENABLED` and
    `AI_GLOBAL_DAILY_BUDGET_USD` with `sync: false` (defaults in `config.ts`: `true` and `2`),
    so a later Blueprint sync never switches the coach back on or restores the budget behind
    the owner's back. Setting `AI_GLOBAL_DAILY_BUDGET_USD=0` the same way also turns it off
    (`budget`).
  - **Instant, without a deploy:** the `meta` row `ai_kill_switch = 'on'` (delete the row to
    undo). `centrate-db` has `ipAllowList: []` and free web services have no shell, so to run
    it: database → **Access Control** → add your own IP, connect with `psql` and the
    database's **External Database URL**, run the statement, then remove your IP again.

    ```sql
    INSERT INTO meta (key, value) VALUES ('ai_kill_switch', 'on')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    ```

  Both answer 503 `feature_disabled` with `reason: 'kill_switch'` and `/health` reports it
  (`RuntimeState.aiKillSwitch`). `AI_USER_DAILY_BUDGET_USD=0` also turns the coach off
  (`budget`). No admin endpoint exists on purpose: it would be one more secret and one more
  public route that can switch things.

- No prompt or answer text is stored or logged; only `ai_usage` / `ai_global_daily` counters
  change (tested by scanning every table and the captured logs after coach calls).

### 10.3 Breaker (automatic, temporary kill switch)

Some failures come from the owner's Anthropic account or settings, not from a request or a
passing outage: the credit or the Console's monthly usage limit spent, a revoked key, a retired
model id or beta header. They fail every call the same way until the owner acts, so without a
breaker every tap would fail while `/health` and the quota kept offering the coach.
`src/coach/breaker.ts`:

- **Strike**: a failure the provider certainly did not bill (`billing: 'none'`) with reason
  `misconfigured` (401, 402, 403, 404, `billing_error`) or `rejected` (other 4xx). A 400 may
  also come from the request itself, so each user adds at most one `rejected` strike to a
  streak: one account cannot switch the coach off for everyone. User text is also cleaned of
  lone UTF-16 surrogates (`oneLine`): JSON carries them, but they are not text and the API
  can reject the body with a 400.
- **3 strikes in a row** open it for **15 minutes**: `/health` reports `coach: kill_switch`
  (`RuntimeState.aiBreakerOpen`, read live, not from the cached probe), every coach route and
  GET `/v1/coach/quota` answer 503 `feature_disabled` `kill_switch` without calling the model,
  and one `coach breaker open` error line is logged (class and status only).
- Any answer, or a failure after the model ran, ends the streak. Unbilled `unavailable`
  failures (overload, 429, 5xx, network) neither add to it nor end it.
- When the 15 minutes end calls go through again, but a single strike opens it again at
  once; an answer ends the streak.
- In process memory, one per `CoachModel`: a restart (a deploy, the free service waking up)
  closes it, and the next three strikes open it again. The owner fixes the cause (credit, the
  Console limit, `ANTHROPIC_API_KEY`, `AI_MODEL_*`, or `AI_REFUSAL_FALLBACKS=false` for a
  retired beta header); nothing needs resetting.

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

| Page               | Owner  | What                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cuenta`          | CORE   | «Continuar con Google» and «Recibir un código por email»; signed in: email, links to the panel, «Cerrar sesión», the open browser sessions (start and expiry dates only: no IP or browser is stored) and «Cerrar sesión en los demás navegadores». Notice «Debes tener al menos 14 años» (LOPDGDD art. 7) and a link to the privacy page. `?volver=` accepts only relative `/cuenta…` paths |
| `/cuenta/codigo`   | CORE   | Landing of the email link; reads `email` and `otp` from the fragment; «Entrar» signs in                                                                                                                                                                                                                                                                                                     |
| `/cuenta/conectar` | CORE   | §4.2 steps 3–5; with a sign-in older than 15 minutes, «Vuelve a iniciar sesión» (sign out, sign in, back here) instead of «Conectar»                                                                                                                                                                                                                                                        |
| `/cuenta/panel`    | CLIENT | Charts of the last 12 weeks (focus and study minutes, points won and lost, goal days) from `GET /v1/stats`; devices with «Quitar»; «Borrar las estadísticas»; «Descargar mis datos»; «Borrar mi cuenta» (typed confirmation). The three deletions need a fresh session: on `reauth_required` the page shows «Iniciar sesión otra vez» (sign out, sign in, back)                             |
| `/cuenta/avisos`   | CLIENT | A partner's inbox: recent alerts, «Aprobar» / «Rechazar» for pending approvals                                                                                                                                                                                                                                                                                                              |
| `/i/:code`         | SOCIAL | Public invite landing: «Te han invitado a Céntrate», the code with «Copiar», how to add it in the app (Amigos → «Tengo un código»), download link. Never looks the code up or shows who invited                                                                                                                                                                                             |

Pages that need a session redirect to `/cuenta?volver=…`. Their scripts call the JSON API with
the cookie session (same origin; §4.1 CSRF rule applies).

`/cuenta/panel` and `/cuenta/avisos` are rendered on the server from what the JSON API answers
to the same session (`GET /v1/me`, `/v1/stats`, `/v1/accountability/inbox` through
`app.inject`): the same checks and numbers, no second copy of the queries, and they read
without JavaScript. The 12 weeks are ISO weeks in the profile's zone, the current one last.
Each chart has one color (tokens), no grid but the baseline, a `<title>` per week (hover), an
`aria-label` and a text summary, plus a data table; it is drawn twice (wide and narrow) and
`panel.css` shows the one that fits. Actions (`panel.js`, `avisos.js`) need JavaScript:
«Quitar» a device and «Borrar las estadísticas» confirm with a second click («¿Seguro?»),
«Borrar mi cuenta» needs `BORRAR` typed and, on `reauth_required`, signs out and sends the user
to `/cuenta?volver=/cuenta/panel#datos`; «Aprobar» / «Rechazar» take an optional note (≤ 140).

## 12. Rate and size limits

`@fastify/rate-limit`, in memory (one instance; a restart after sleeping resets counters, so
anything that must hold across restarts, AI quotas, partner emails and sign-in emails, lives in
Postgres). Key: `u:<userId>` when a session resolved, else `ip:<client>`, where an IPv6 client
counts as its /64 (one connection or server usually holds a whole /64) and an IPv4-mapped
address as the IPv4 one (`src/lib/ip-limit.ts`). 429 carries `retryAfterSeconds` and
`Retry-After`.

**Floods never reach Postgres unthrottled** (the pool has 5 connections):

- The session lookup (one query) runs in `onRequest`, before the route limiter can know the
  user, so it sits behind its own per-IP gate: 300 lookups per minute per client, then 429
  without touching the database. Unknown routes and `/health` never look a session up.
- The 404 handler is rate limited like any route (`@fastify/rate-limit` does not hook it by
  itself).
- `/health` caches what it reads from Postgres (ping, epoch, kill switch, budgets) for 10 s
  behind one in-flight probe, so any number of checks costs at most one probe per 10 s.
- Every pooled statement has `statement_timeout` 10 s (and a 15 s client-side
  `query_timeout`); idle transactions end after 30 s. Timeouts, a pool with no free
  connection and connects that hang map to 503 `database_unavailable` (`isDatabaseUnavailable`
  also recognises node-postgres' code-less connection errors).

**The client IP depends on `TRUST_PROXY_HOPS`.** Every IP-keyed limit (all unauthenticated
routes, the session gate) is only as good as this value: too low and every client shares the
proxy's bucket; too high and clients can spoof `X-Forwarded-For`. Render's documented chain is
one proxy (`1`). To check it on a deploy: set `LOG_LEVEL=debug` for a few minutes, request
`/health` from your own machine without an `X-Forwarded-For` header, and read `xffEntries` in
that request's log line (the number of addresses in the header, never the addresses). That
number is the right `TRUST_PROXY_HOPS`; then set `LOG_LEVEL` back to `info`. Pending until the
first deploy (`PENDIENTE_PARA_MI`).

| Scope                                                    | Limit                                            |
| -------------------------------------------------------- | ------------------------------------------------ |
| Everything (default), unknown routes included            | 120 per minute                                   |
| Session lookups (before the route limit)                 | 300 per minute per IP                            |
| `/health` (cached 10 s)                                  | 300 per minute per IP                            |
| Email code send, per IP (Fastify route limit, in memory) | 5 per 15 min                                     |
| Email code send, per mailbox (Postgres)                  | 3 per clock hour, 10 per UTC day                 |
| Email code send, all addresses together (Postgres)       | `SIGNIN_EMAILS_PER_DAY` (50) per UTC day         |
| Partner emails, per partner (Postgres)                   | 10 per UTC day                                   |
| Partner emails, everybody together (Postgres)            | `PARTNER_EMAILS_PER_DAY_GLOBAL` (40) per UTC day |
| Email code sign-in (`/api/auth/sign-in/email-otp`)       | 20 per 15 min per IP (5 attempts per code)       |
| `POST /v1/app-auth/authorize`, `/token`                  | 20 per hour                                      |
| `PUT /v1/sync/days`                                      | 60 per hour                                      |
| `PUT /v1/presence`                                       | 4 per minute                                     |
| `POST /v1/friends/invites`                               | 10 per day                                       |
| Invite preview and accept                                | 20 per hour                                      |
| Accountability events and decisions                      | 30 per hour                                      |
| `/v1/coach/*` (plus the daily quotas)                    | 10 per minute                                    |
| `GET /v1/me/export`, `DELETE /v1/me`                     | 3 per hour                                       |
| `POST /v1/sessions/revoke-others`                        | 10 per hour                                      |

**Sign-in emails** (`src/auth/email-limits.ts`) are what an anonymous caller can make us send,
and the Resend free plan allows about 100 emails a day for everything (codes and partner
alerts). Partner emails have their own global cap (§9), so the two caps together
(`SIGNIN_EMAILS_PER_DAY` + `PARTNER_EMAILS_PER_DAY_GLOBAL`, 50 + 40 by default) stay under the
plan and alerts never use up the codes' share. The mailbox counter keys on the normalised address (lower case, `+tag` removed, and
for Gmail the dots removed and `googlemail.com` read as `gmail.com`), stored only as an HMAC
with `BETTER_AUTH_SECRET`, so plus and dot variants cannot bomb one inbox. Past the global cap
the route answers 503 `feature_disabled` (`emailLogin`, `budget`), `/health` shows it, and the
page says «Hoy ya no podemos enviar más códigos por email» until 00:00 UTC; Google sign-in keeps
working. The IP limit runs first, then the Postgres caps, so a request refused by IP counts
against nothing. A request from another site (a form, or JSON without our Origin) is refused
with 403 before either (§4.1, sign-in rule), so it cannot spend the caps either.

Body limits: 32 KB by default, 256 KB for `PUT /v1/sync/days`, 16 KB for coach routes, 4 KB
for the one urlencoded form (`POST /v1/app-auth/authorize`).

## 13. Privacy, logging and GDPR

- **What leaves the machine, per switch** (all off by default): `syncStats` → the numeric
  `CloudDayStats`; `ranking` → friends see weekly focus/study minutes, active days, goal days,
  only for days since the friendship and since the ranking was last turned on (never earlier
  weeks);
  `presence` → friends see focus/study, since, ends; accountability → partners see event kind,
  time and the approval outcome, and an event no partner hears about is not stored (§9); `coach` → the text the user typed for that request goes to
  Anthropic (processed in the United States under Anthropic's API terms), is never stored by
  us, and the first use shows a notice in the app.
- **Logs** (pino): one line per request with request id, method, **route pattern** (never the
  raw URL: codes and tokens travel in paths), status and duration. No IPs, user agents,
  headers, query strings, bodies, emails or tokens; serializers and `redact` enforce it, and a
  test scans captured output. Errors are logged by type and code (plus stack for 5xx), never
  by message (messages can quote values). Prompts and answers are never logged.
- **Error logs** keep only the stack frames (`at …` lines): a stack's first lines repeat the
  message, and a failed query's message lists its SQL parameters (tokens, emails). Driver errors
  wrapped by Drizzle are still recognised as `database_unavailable` through their `cause`.
- **Security headers:** helmet (strict CSP above, `Referrer-Policy: no-referrer`, HSTS in
  production); `Cache-Control: no-store` on every response.
- **GDPR:** `GET /v1/me/export` (every stored value about the user; other people only as id
  and display name; no tokens or hashes) and `DELETE /v1/me` (hard delete by cascade, plus the
  user's `verification` rows by identifier; the answer expires the session cookie). The export
  also carries `usageCounters`, the Google subject id (`loginMethods[].accountId`) and each
  device's `installId` (the export only; `/v1/devices` never shows it). `user.name` is not
  a second copy of the name: it is emptied once the display name is seeded (§4.1).
  `src/lib/gdpr.ts` keeps `USER_DATA_COVERAGE`, which classifies **every column** of every table
  with user data as exported (where) or `not exported: <why>`; the social part comes from
  SOCIAL's `exportSocialData`. test/gdpr.test.ts enumerates the tables with a user column and
  their columns from the schema, so a new table or column fails until it is classified, and
  checks that every value marked exported appears in a real export.
- **Anti-abuse counters** (`rate_counters`, and `ai_identity_daily` for the day's AI use per
  mailbox, §10.2) hold an HMAC of a normalised address, never the address, and last at most a
  day (`ai_identity_daily`: until its UTC day ends, so under 48 h); they are not linked to an
  account, so they are neither exported nor deleted with it (that is their point: a new
  account on the same address does not get a fresh AI allowance the same day).
- **Retention:** §6. **Region:** Frankfurt (EU).
- **Age:** Spain requires 14 to consent (LOPDGDD art. 7); the sign-in page says so.
- `PRIVACY.md` (another team) must gain: what each switch shares, the Anthropic processing
  notice, retention times, the region, how to export or delete, and that the anti-abuse
  counters (an HMAC of the address, never the address; the AI one kept until its UTC day ends,
  under 48 h) outlive an account deletion on purpose.

## 14. Desktop client contract

For the desktop team (and the CLIENT builder's `cloud-api.ts` client):

- **Only the Electron main process calls the API.** The token lives in `safeStorage`; the
  renderer never sees it and CORS never applies.
- **Time zone.** `exchangeLoginCode` sends the system's IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) as `AppTokenRequest.timeZone`, and the
  server stores it as the profile's on every login. Whenever the system zone changes (checked
  at app start and when the machine wakes or the OS reports a change) and differs from
  `me.profile.timeZone`, send `PATCH /v1/me { profile: { timeZone } }`. The ranking week, the
  partner alert deadlines («hasta las 18:55»), the sync window's «today» and the weekly summary
  all follow the profile's zone, so a stale one is hours off outside Spain.
- **Fresh sessions** (§4.3). `deleteAccount`, `revokeOtherSessions({ includeDevices: true })`,
  `removeDevice` for another computer and `deleteSyncedDays` for all devices or another one
  need a sign-in less than 15 minutes old; the desktop session counts from the browser sign-in
  that connected it. On 403 `reauth_required`, explain («Por seguridad, vuelve a iniciar
  sesión») and run the loopback login again (the browser asks to sign in again if its own
  sign-in is old), then retry. Disconnecting this computer (`removeDevice(ownDeviceId)`) and
  deleting only its own stats (`deleteSyncedDays(ownDeviceId)`) never need it.
- **The UI never waits on the API.** Timeouts (`CLOUD_TIMEOUTS`): background 10 s, user-started
  60 s with «Despertando el servidor…» (a cold start takes about a minute), coach 100 s. At app
  start, when signed in, fire a `GET /health` to wake the service.
- **Coach calls never pay for a cold start inside their timeout.** The free service sleeps
  after 15 minutes idle, and a cold start (about 60 s) plus the longest model deadline
  (study-plan, 80 s) would outlast any sensible single timeout, so the client does it in two
  steps: when the server has not answered this client for `awakeMs` (10 min), `interpret`,
  `splitTask`, `studyPlan` and `weeklySummary` first send `GET /health` with the interactive
  timeout (60 s) and call `onWaking` (`CoachCallOptions`) so the app shows «Despertando el
  servidor…»; then the coach request gets `coachMs` (100 s = the longest server deadline plus
  20 s for the quota bookkeeping and the network; a test in `apps/api` keeps it above every
  `ENDPOINTS` deadline). Any JSON answer of ours (success or error envelope) counts as awake;
  a proxy page does not. A failed wake-up rejects with `operation: 'health'`: nothing reached
  the model, so it is retryable as usual. `postAccountabilityEvent` wakes the server the same
  way (it takes `onWaking` too, `WakeCallOptions`) and then posts with its own background
  timeout, so the first `emergency_requested` after a quiet spell is not lost to a cold start.
- **Errors** (`CloudError { kind: 'offline' | 'timeout' | 'aborted' | 'http' |
'invalid_response', operation, status, code, details, retryable, retryAfterMs }`): retry
  network errors, timeouts, non-JSON answers (captive portals), 429 `rate_limited` (honouring
  `Retry-After`) and 5xx except `feature_disabled` (unless `reason: 'database_down'`),
  `not_implemented` and `coach_incomplete`; never retry other 4xx or `quota_exceeded` (its
  `retryAfterMs` runs to `resetsAt`). **Coach model calls** (`interpret`, `splitTask`,
  `studyPlan`, `weeklySummary`) are the exception: the coach endpoints take no idempotency key
  and a request that reached the model is counted and billed even when its answer is lost, so
  `retryable` is true only for answers given before the model runs (429 `rate_limited`, 503
  `feature_disabled` with `database_down`). A timeout, a lost connection, a non-JSON answer,
  `coach_unavailable` or any other 5xx is never resent automatically: the app shows the error
  and the user may try again (a new request against the daily quota). **401** → mark the app
  as signed out, drop the outbox, keep all local data (`onUnauthorized` hook,
  `error.isUnauthorized`). Messages carry the method name, never a URL, code or token.
- **Coach actions and the quota**: decide whether to offer a coach action from
  `getCoachQuota().available` (`interpret`, `splitTask`, `studyPlan`, `weeklySummary`), not
  from `requestsLeft`: a study plan needs more of the day's spend cap than a phrase, so it can
  be unavailable while requests are left. Disable an unavailable action until `resetsAt`; a
  429 `quota_exceeded` can still happen (another device used the quota meanwhile) and is final
  for the day.
- **Offline outbox** (persisted by the app in its SQLite; the shared helpers are pure):
  - `putDays` items collapse by `(deviceId, day)` keeping the highest `rev` (the later one on
    a tie), sent in batches of 100.
  - Accountability events keep their `clientRef` and are never merged away. An
    `emergency_requested` is not queued first: it goes out directly
    (`sendAccountabilityEvent`, below) and reaches the outbox only after a retryable failure.
  - Presence heartbeats and approval polls are never queued.
  - **Two lanes, two backoffs.** Events and day totals back off separately
    (`OutboxState.events`, `OutboxState.days`): a 429 or a 5xx on `PUT /v1/sync/days` never
    holds an accountability event (`emergency_confirmed`, `study_abandoned`, a queued
    `emergency_requested`), and a failing event never holds day totals. In a flush, the lane
    that fails closes and the other carries on. Each backoff runs with jitter from 30 s to
    30 min, or the server's `Retry-After` when longer (at most 6 h).
  - **Sync pace.** `PUT /v1/sync/days` allows 60 requests per hour per user, shared by all of
    the user's computers, and the app queues a new snapshot on every guardian event (each
    blocked-site attempt raises `rev`) and while a block runs. So the outbox sends day totals
    at most once per `CLOUD_OUTBOX.dayIntervalMs` (10 min) per computer and coalesces them
    meanwhile (each day's latest snapshot only): at most six rounds an hour per computer, one
    request each outside a sign-in re-upload (at most four), which keeps even five computers
    near half the limit. Events are never paced. `flush({ force: true })` skips the pace and
    the backoffs: use it only when the user asks («Sincronizar ahora») or the network comes
    back.
  - Days before `syncWindowStart(now)` (§7) are dropped without a request, like events older
    than 7 days.
- **Client** (`createCloudClient({ baseUrl, getToken, fetch?, timeouts?, onUnauthorized? })`):
  one method per endpoint (`health`, `exchangeLoginCode`, `getMe`, `putDays`, `getRanking`,
  `postAccountabilityEvent`, `decideApproval`, `splitTask`…), each with the timeout of its
  class (background, interactive, coach) unless the call passes `timeoutMs`, and an optional
  `signal` (coach model calls and `postAccountabilityEvent` also take `onWaking` and wake the
  server first, as above). Fetch runs with `credentials: 'omit'`, `cache: 'no-store'`,
  `redirect: 'error'`. It never retries by itself. `removePartner` returns null (removed now)
  or the link (ends in 24 h). `postAccountabilityEvent` takes the event without `sentAt` and
  stamps it from `now()` on every call, after any wake-up; the outbox stores events without
  it. The app does not call it directly: see `sendAccountabilityEvent` and `addEvent`.
- **Outbox** (`createOutbox({ storage, client, onEventSent? })` with `addDays`, `addEvent`,
  `flush({ force })`, `pending`, `nextFlushAt`, `clear`): the app persists `OutboxState`
  through `storage` (its SQLite); `memoryOutboxStorage` is for tests. A flush sends events
  first, then days per device in batches of 100, runs one at a time, and never holds its lock
  during a request. Each event the server takes (201, or 200 for a replay) leaves the queue
  and its answer (`eventId`, `approval`) goes to `onEventSent(event, response)`: this is how
  the app learns the `eventId` of an `emergency_requested` that could not go out directly and
  starts polling it while the approval is `pending` and its countdown runs (the callback is
  not awaited and cannot break a flush). `OutboxFlushResult` itself carries only counts.
  After an answer only the snapshots that were sent leave the queue (every field compared),
  plus lower revs and, for days the server answered `stale`, the same rev: a snapshot queued
  meanwhile stays even with the same `rev`, because a running block grows the minutes without
  a new guardian event and the server lets an equal `rev` overwrite. Outcomes: `done`,
  `retry_later` (the failing lane's backoff; the other lane still went), `waiting` (every
  queued item waits for its lane), `signed_out` (401: queue emptied) or `empty`. Items the server will never take are dropped (the exact snapshot or event sent):
  other 4xx, only the rejected days of a `validation_failed` batch, and events older than
  7 days; `feature_disabled` keeps them and backs off. Call `flush` after queuing (the outbox
  paces day totals itself), then again at `nextFlushAt` whenever it is not null, whatever the
  status (a `done` flush that sent an event may leave day totals waiting for the pace), and
  with `force` when the user asks or the network comes back.
- **Helpers:**
  - `sendAccountabilityEvent(client, outbox, event, options?)` → `SendEventResult`: the path
    for `emergency_requested` (§9); `options` takes `onWaking` and `signal`. It wakes the
    server, posts the event and returns `sent` with the answer (`eventId`, `approval`: poll it
    while `pending`); on a retryable failure it queues the event and returns `queued` (fail
    open until `onEventSent` reports the replay's answer); `dropped` for a permanent 4xx;
    `signed_out` on 401. The other kinds go straight to `outbox.addEvent`.
  - `approvalOutcome(approval, now, countdownEndsAt)` → `wait | approved | denied` (fails
    open; `countdownEndsAt` is the local one sent with the request, on the same clock as
    `now`).
  - `cloudWasReset(rememberedEpoch, health)`: true only for `db: 'up'` with a non-null
    `serverEpoch` different from a remembered non-empty one. Never compare the epochs with
    `!==` yourself: `serverEpoch: null` (database unconfigured, down or its probe failed)
    means «unknown», and dropping the token and the outbox then would lose queued events and
    stats snapshots over a brief outage.
  - `daysToReupload(localDays, syncState, now?)` after every sign-in and after a reset (§7):
    the days from `syncWindowStart(now)` on that the server lacks or holds at the same or a
    lower `rev` (at most 400 days: four requests).
  - `syncWindowStart(now)`: the oldest day every server accepts whatever the profile's zone
    (`today − 400` with one day of margin).
  - `newClientRef()`.
- **Polling:** approval every 15 s while `approvalOutcome` says `wait` (the `eventId` comes from
  `sendAccountabilityEvent` or `onEventSent`); inbox and friends' presence every 60 s while the
  Amigos window is open; ranking on open.
- **Cloud reset** (`/health` read at start and before acting on a 401; `cloudWasReset` true) →
  the account is gone: drop the token, device id and outbox, keep local data, show «La nube se
  ha reiniciado: vuelve a conectar»; after the new login re-apply the remembered choices the
  user confirms (`PATCH /v1/me`), then `GET /v1/sync/state` and `daysToReupload`. A `null`
  epoch changes nothing (remember the epoch only when it is a string). The full sequence is in
  §7.
- **Study plans** cover at most `CLOUD_LIMITS.studyPlanMaxDays` (28) calendar days. With
  `truncated: true` the app shows the plan up to `coversUntil`, says it is partial, and offers
  to ask for the rest later (a new `studyPlan` with a later `today`).
- **Feature discovery:** read `capabilities` from `/health` and hide what is off.

## 15. Deploying on Render

`render.yaml` gains (CLIENT; the static site entry stays exactly as it is):

- **Web service** `centrate-api`: `runtime: node`, `plan: free`, `region: frankfurt`,
  `buildCommand: npm ci --include=dev && npm run build -w apps/api` (with `NODE_ENV=production`
  a plain `npm ci` skips the devDependencies the build needs),
  `startCommand: node apps/api/dist/server.mjs`, `healthCheckPath: /health`,
  `maxShutdownDelaySeconds: 120` (see the shutdown bullet below), `buildFilter.paths: [apps/api/**, packages/shared/**, package-lock.json]`.
  Env: `NODE_VERSION=22`, `NODE_ENV=production`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`,
  `TRUST_PROXY_HOPS=1`,
  `SIGNIN_EMAILS_PER_DAY=50`, `PARTNER_EMAILS_PER_DAY_GLOBAL=40`; `DATABASE_URL` from the database's `connectionString`; `BETTER_AUTH_SECRET` with `generateValue: true`; `BETTER_AUTH_URL`,
  `APP_ORIGINS`, Google, Resend and Anthropic keys with `sync: false` (filled in the dashboard;
  left empty means off). `AI_ENABLED` and `AI_GLOBAL_DAILY_BUDGET_USD` are `sync: false` too
  (empty = the `config.ts` defaults, `true` and `2`): they are what the owner changes in an
  incident (§10.2), and a declared `value` would be restored by the next Blueprint sync (any
  push that touches render.yaml). `PENDIENTE_PARA_MI.md` §5 lists where each key comes from.
- **Database** `centrate-db`: `plan: free`, `region: frankfurt`, `ipAllowList: []` (reachable
  only from Render's private network). Render allows one free database per workspace. For a
  one-off manual query (the `meta` kill switch, §10.2) add your own IP under the database's
  Access Control, connect with its External Database URL, and remove the IP afterwards.

**Free-tier limits the app is built around:**

- The free web service **spins down after 15 minutes without traffic**; the next request waits
  for a cold start of about a minute. Free instance hours are capped per workspace each month
  (750 h at the time of writing). Presence heartbeats keep it awake only while someone is
  focusing.
- The free Postgres **expires** (30 days after creation at the time of writing, then a short
  grace period before deletion) and has 1 GB. When it is recreated, `serverEpoch` changes and
  **everything in it is lost**: accounts, sessions, devices, sharing choices, stats and social
  data. Every user must connect again; the app then re-applies the choices the user confirms
  and re-uploads stats from its own history (§7). Friends and partners must be added again.
  For a durable service, upgrade the database (a `PENDIENTE_PARA_MI` item).
- Migrations run at boot (no pre-deploy command on the free plan), on their own connection
  without the pool's statement timeouts (`src/boot.ts`, `src/db/migrate.ts`). When Postgres
  cannot be reached at boot (an expired free database, a host that never answers so the
  connect times out, a refused connection, a network blip) the server starts anyway: `/health`
  says `db: down`, `/v1` answers 503 `database_unavailable`, and migrations, the server epoch
  and the janitor are retried every 60 s. Anything that fails before the first migration
  statement (connecting, taking the advisory lock, waited for at most 60 s) is retried; only a
  failing migration itself stops the process.
- `TRUST_PROXY_HOPS=1` must match Render's proxy chain; check it once after the first deploy
  (§12).
- `SIGTERM`/`SIGINT` close the server gracefully: in-flight requests finish, new ones get 503,
  the pool closes. A coach call in flight is waited for too: cutting it short would leave its
  worst-case quota reservation held (§10.2). Closing the HTTP server only waits for open
  connections, so every async route handler is also tracked (`src/lib/in-flight.ts`, wired in
  `app.ts`) and `app.close()` resolves only after the last one returns: a coach call whose
  client left (the app was closed, the request cancelled) still settles before the pool
  closes. Every answer sent while closing carries
  `Connection: close`, so the process exits as soon as the last request is done instead of
  waiting for keep-alive connections. A forced exit follows after `SHUTDOWN_TIMEOUT_MS`
  (`src/boot.ts`: the longest coach deadline plus its 30 s settle margin plus 5 s = 115 s), so
  Render must wait longer than its 30 s default before killing the process:
  `maxShutdownDelaySeconds: 120` in render.yaml (a test checks the two agree). With zero-downtime
  deploys the new instance already takes the traffic meanwhile. A process killed anyway (out of
  memory, a crash) leaves its holds to the janitor (§6).
- The Render account is at its 25-service limit (DECISIONS.md), so deploying needs a free slot:
  a `PENDIENTE_PARA_MI` item, like creating the Google OAuth client (redirect
  `{API}/api/auth/callback/google`), verifying a Resend domain and adding the Anthropic key and
  budget.

## 16. Testing

Vitest with PGlite (in-process Postgres) and the real migrations.

- `test/helpers/db.ts`: `createTestDb()` (one per test file), `resetDb()`.
- `test/helpers/blackhole.ts`: a TCP server that accepts and never answers (a hung Postgres
  host) and a closed port, for boot and connection-error tests.
- `test/helpers/app.ts`: `testConfig()` (accounts, Google and email on; no Anthropic key),
  `fakeClock()`, `fakeMailer()`, `createTestUser(db, { displayName, sharing, timeZone,
sessionCreatedAt… })` (user + profile + bearer session; `sessionCreatedAt` is also its sign-in time), `tokenSessionResolver()` and
  `buildTestApp({ db, clock, … })`. SOCIAL and COACH test through bearer tokens without
  better-auth; CORE tests the real better-auth flows.
- Existing tests: config and capabilities, ISO weeks and local days, health with and without a
  database, the error envelope, log hygiene.
- CORE's tests: `auth` (email code end to end, sign-in email caps per mailbox, per /64 and
  global, Google sign-in and linking with Google's token endpoint stubbed (an unverified
  address never joins an existing account nor creates one; no session of an unverified account
  resolves), cookies and bearer on the real resolver, desktop
  (sliding) and browser (14 days, fixed) lifetimes, CSRF for cookie writes, the sign-in rule
  (a cross-site form with a valid code signs nobody in; cross-site code requests count
  nothing), sign-in methods per configuration, unreachable better-auth endpoints), `flood`
  (session gate, 404 limit, cached health), `boot` (a database that never answers or refuses:
  the server listens, reports `db: down`, retries; shutdown waits for a request in flight and
  then closes its keep-alive connection; `SHUTDOWN_TIMEOUT_MS` and render.yaml agree),
  `app-auth` (connect page, authorize, PKCE token, reuse, limits, logout; an old browser
  session gets no code and so no desktop session to delete the account with; the desktop
  session inherits the sign-in time; the time zone is stored), `sessions` (list, sign out the
  others, computers only on request and with a fresh session, a computer counted from the
  sign-in that connected it, `/cuenta`), `me` (removing another computer needs a fresh
  session, disconnecting itself not), `sync` (deleting all or another computer's stats needs a
  fresh session), `gdpr` (schema-driven), `janitor` (retention, dead AI holds), `mailer`,
  `account-pages`, `errors` (real node-postgres connection errors).
  `test/helpers/core.ts` signs cookies like
  better-auth and builds the app on the real resolver.
- `vitest.config.ts` gives hooks 60 s: every file starts its own PGlite, which takes seconds
  on a busy machine.

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
  tie ranks, never retroactive (weeks before the friendship, before the friend or the caller
  turned the ranking on, off and on again); presence TTL with the fake clock, since kept, consent both ways, blocks;
  partner lifecycle incl. 24 h delays; events idempotent on `clientRef`; approval approve/deny,
  a denial wins over an earlier approval, only partners who must approve decide (403 for the
  others), late → 409, expired on read, not-a-partner → 404; presence and events read the app
  clock only relative to `sentAt`; email content (snapshot of the fake mailer: no reason,
  domain or task), the 10-per-day and global caps, one message at a time with one retry on a
  short 429.

### COACH: coach routes, Anthropic client, quotas

- `routes/coach.ts`, `src/coach/` (`model.ts` seam, `anthropic.ts`, `prompts.ts`, `schemas.ts`,
  `quota.ts`, `budget.ts`, `interpret.ts`) per §10. Wire the default `coachModel` in `buildApp`
  (one line) and nowhere else.
- Tests with a fake `CoachModel`: capability and consent gates; schemas and server-side
  clamping; interpret accepts only phrases `parseIntent` reads fully (an invented service is
  dropped), shifted clock correct across zones; `suggestedPhrase` filtering; refusal → 422,
  `max_tokens` → 502, SDK errors → 503; quota N+1 → 429 with `resetsAt`, one call in flight
  per user and bucket (429 `rate_limited`), the per-user spend cap, global budget held by
  calls in flight → 429 `rate_limited`, settled → 503 `budget` and health shows it (settled
  spend only), kill switch and breaker; no text in any table
  afterwards. Tests drive the real SDK against a local fake SSE server to assert model ids,
  `cache_control` on the system prompt, `max_tokens`, the fallback beta header and
  `metadata.user_id` being the HMAC, the one retry, what failed calls book (§10.2), and that
  the key never appears in responses or logs.

### CLIENT: shared client, pages, Render, README

- `packages/shared/src/cloud-api.ts`, end of file: `createCloudClient({ baseUrl, getToken,
fetch?, timeouts? })` with one typed method per endpoint, `CloudError`, the outbox helpers
  (`coalesceOutbox`, `nextRetryDelay`, `createOutbox({ storage, client, now, onEventSent })`),
  `sendAccountabilityEvent`, `cloudWasReset` and `daysToReupload` per §14. Pure TypeScript, no
  Node imports, erasable syntax only.
- `pages/panel.ts` (`/cuenta/panel`, `/cuenta/avisos`) per §11, with registered scripts.
- `render.yaml` additions per §15 and a README section (Spanish) on the optional cloud.
- Tests: `packages/shared/test/cloud-api.test.ts` (requests, timeouts per class, offline,
  abort, error mapping and `retryable`, outbox coalescing, backoff bounds, idempotent replay,
  drops, 401, restart), `apps/api/test/cloud-client.test.ts` (the client and outbox against
  `buildTestApp` through a fetch adapter over `app.inject`) and
  `apps/api/test/panel-pages.test.ts` (gates, content, escaping, CSP-safe markup, helpers).

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
  price table is conservative for unknown models. The same holds per user
  (`AI_USER_DAILY_BUDGET_USD`): request and token limits alone let one free account spend most
  of the day's budget on Opus.
- **Failed calls are booked at an upper bound, not released** — a deadline, timeout, reset, a
  body cut off or an `error` event once the model may be writing may have been billed;
  releasing them would let the global cap miss real spend. Only failures that certainly ran
  nothing are released: among them any HTTP error status (4xx or 5xx) answered instead of the
  event stream, since a streaming request that did not get its 200 never generated a token.
  Booking those at the worst case turned an upstream incident into phantom spend (about ten
  taps on a 500 used the default global budget for the day).
- **The user's caps check a call's first hop, not its speculative fallback hop** — the
  fallback hop runs only after a refusal and is booked at its real cost; checking it made a
  study plan fail after one ordinary split task. The global budget still holds the whole
  worst case while the call runs.
- **No minimum account age for the coach** — new accounts sign in precisely to try it; the
  per-user spend cap, one call in flight and the global cap already bound what throwaway
  accounts can take: each needs its own mailbox, because the day's AI use is also counted per
  mailbox (`ai_identity_daily`, an HMAC of the normalised address kept until the UTC day ends),
  so deleting the account and signing up again, or a `+tag` alias, starts where it left off.
- **Rejected for now:** cheers, study rooms, category breakdowns, points snapshots in the cloud,
  public profiles or search, WebSockets (the free service sleeps).
