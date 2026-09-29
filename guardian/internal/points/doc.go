// Package points is the Go port of the pure functions in packages/shared/src/points.ts:
// the event-sourced points ledger (balance, XP, levels, streak), attempt dedupe and
// escalation, penalties, bonuses, refunds, the emergency rules and the Progress summary
// (docs/ARCHITECTURE.md §6).
//
// Every value comes from the embedded rules (guardian/internal/embedded/rules.json,
// generated from rulesSnapshot()); nothing here hardcodes a points value. Parity with
// TypeScript is checked by points_vectors_test.go, which runs
// packages/shared/test/fixtures/points-vectors.json in place.
//
// Everything is pure: no I/O, no clock, no time zones, no goroutines and no shared
// mutable state. Functions never modify their arguments (LedgerState maps are cloned
// before any change), so the single engine goroutine that owns the ledger can keep the
// state it passed in. Times are epoch milliseconds of trusted time and days are the
// envelope's local day (YYYY-MM-DD).
//
// Numbers are int64 where TypeScript uses number: every ledger quantity is an integer
// (TypeScript floors or truncates its inputs), and Go integers have no negative zero, so
// the TypeScript neg() helper has no counterpart.
//
// Achievements and the mascot (points.ts §«Achievements and mascot») are app-only and
// have no port here.
package points
