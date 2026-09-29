// Package integration holds the guardian's end-to-end tests (docs/ARCHITECTURE.md §15):
// the real engine, the real HTTP API and the real hosts.Manager, assembled by
// internal/daemon exactly as the binary does, on temporary directories selected with
// CENTRATE_DATA_DIR and CENTRATE_HOSTS_PATH and driven by the engine's FakeClock. No
// admin rights, no system hosts file, no network beyond 127.0.0.1.
//
// Build with -tags testhooks to also run the tests of POST /v1/_test/clock against the
// persisted fake clock of testhooks builds. The package has no non-test code.
package integration
