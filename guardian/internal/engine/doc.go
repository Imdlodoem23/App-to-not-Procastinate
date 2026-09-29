// Package engine is the guardian's core (docs/ARCHITECTURE.md §10): the single
// goroutine that owns every entity (blocks, punishments, study sessions, emergencies,
// allowances, schedules, settings) and the points ledger, runs the time-driven step
// every 2 s and before every command, commits mutations in the contract's order
// (event log first, then memory, enforcement, anchor, response, state.json, §11.3),
// renders enforcement (hosts section, process watcher, extension rules, §10.10), keeps
// the trusted clock (§4, §10.2) and runs the startup and recovery ladder (§10.12).
//
// The API layer calls the exported command methods (CreateBlock, State, Events…); each
// runs in one engine turn. See README.md for the file ownership map, the command list
// and how to add a handler.
//
// Tests drive everything deterministically with FakeClock and the fakes of fakes.go:
// without Start no goroutine runs, and Step runs exactly one tick.
package engine
