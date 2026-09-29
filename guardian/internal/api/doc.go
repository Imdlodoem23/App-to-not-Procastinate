// Package api is the guardian's local HTTP API (docs/ARCHITECTURE.md §8, §9): a server
// bound to 127.0.0.1:<port> only (config.json port, default the embedded default
// port) in front of the engine's commands.
//
// Every request goes through the pipeline of §8.3, in order:
//
//  1. Host must be exactly 127.0.0.1:<port> or localhost:<port> (403 host_not_allowed,
//     anti DNS rebinding).
//  2. Origin, when present, must be an allowed extension origin (403
//     origin_not_allowed on every route); preflights are answered here (cors.go).
//  3. Route and method, generated from the embedded route table (404 not_found, 405
//     method_not_allowed with Allow). There is no route that ends, shortens, edits or
//     deletes a block; testOnly routes exist only with the testhooks build tag.
//  4. Bearer token and scope (401 unauthorized, 403 insufficient_scope); app-token
//     requests carry no Origin; extension tokens keep their bound origin; the
//     loopback peer process is checked for the pairing claim and the extension and
//     Nuclear heartbeats (auth.go, peer*.go).
//  5. Rate limits (§9.6, 429 rate_limited with Retry-After).
//  6. Frozen and safe mode refuse writes (503 read_only).
//  7. Query and body: application/json (415), at most maxBodyBytes (413), strict JSON
//     (duplicate keys and malformed JSON 400 invalid_json), strict shape (400
//     unknown_field, 422 validation_failed; decode.go).
//  8. Idempotency-Key (§8.6) and one engine turn; the engine stores and replays
//     idempotent responses (Idempotent-Replayed: true).
//
// GET /v1/state and GET /v1/ext/rules answer 304 to a matching If-None-Match; GET
// /v1/events and GET /v1/ext/rules long-poll (at most 4 per token). Errors are
// {"error": {code, message, details}} with the embedded status of their code. Every
// response carries Cache-Control: no-store and X-Centrate-Api-Version.
//
// On every start the server rotates the app token and writes client.json (§9.2) once
// the port is bound. Logs never contain tokens, Authorization headers, pairing codes,
// idempotency keys, bodies or paths with ids: only route ids, statuses and error codes.
package api
