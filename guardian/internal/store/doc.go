// Package store persists the guardian's durable data in the system directory
// (docs/ARCHITECTURE.md §7.1, §10.12 and §11): the append-only event log and its HMAC
// chain, the state snapshot with its previous generation, the markers the startup and
// recovery ladder reads, and the rollback anchor kept outside the directory.
//
// # Layout (inside the directory given to Open)
//
//	state.json, state.prev.json     snapshot and previous generation, sealed with a MAC
//	events/current                  current epoch id
//	events/<epoch>/00000001.jsonl   segments named by their first seq, rolled at 8 MiB;
//	                                the MAC chain spans segments
//	quarantine/                     torn tails, partial batches, corrupt lines, bad
//	                                snapshots, replaced epochs
//	backups/state.v<N>.json         pre-migration snapshots (the last 3)
//	secret/ledger.key               32 random bytes: HMAC key of the log, state.json and
//	                                run/clock.json
//	run/guardian.lock               exclusive lock held while a Store is open
//	run/clean-shutdown              written by MarkCleanShutdown, consumed by Open
//	run/planned-stop                written by WritePlannedStop or MarkPlannedStop,
//	                                consumed by Open (valid for 10 min)
//	run/starts.json                 recent unclean starts (safe mode at 3 within 5 min)
//	run/clock.json                  Detector snapshot, sealed (SaveClock, LoadClock)
//	run/purge-pending               a data deletion to finish: written by NewEpoch
//	                                before the switch, removed by FinishPurge; Open
//	                                resumes the deletion while it exists
//
// secret/, run/, events/ and quarantine/ are private (SYSTEM and Administrators only;
// root 0700): no other local account may open a file in them, so none can hold the
// lock or a share-none handle across a restart. backups/ stays readable by every local
// account (§11.1). state.json, state.prev.json and backups/state.v*.json are readable
// by every local account on POSIX; on Windows they are created with a protected
// SYSTEM + Administrators DACL (statePerm), since a share-none handle held on a
// readable snapshot would make every MoveFileEx over it fail.
//
// The rollback anchor lives outside the directory, behind [AnchorStore]: the registry
// on Windows, a plist in /Library/Preferences on macOS, /etc/centrate/anchor.json on
// Linux ([OSAnchor]); tests use [MemAnchor].
//
// # Event lines
//
// One JSON object per line with the fields in this order: v, epoch, seq, at,
// wallOffsetMs, day, type, points, xp, txEnd, req, data, prevMac, mac. B is the line
// without its mac member (a complete JSON object ending with prevMac); mac is
// base64url(HMAC-SHA256(ledger.key, B)) without padding, appended as the last member;
// prevMac is the previous line's mac ("" on the first line of an epoch). Verification
// works on the raw bytes, never on a re-encoding. state.json and run/clock.json are
// sealed the same way.
//
// # Commit and recovery
//
// [Store.AppendBatch] assigns seq, prevMac, mac and txEnd (on the last event only),
// writes the whole batch with one write on an O_APPEND handle and fsyncs it; on
// failure it truncates the segment back and changes nothing (a [WriteError]; the API
// answers 503 read_only with [ReadOnlyReason]). [Open] runs the store's part of the
// startup ladder (§10.12 steps 1-7): lock, stale temporary files, markers, ledger key,
// state candidates, log verification (a torn final line is truncated, a trailing batch
// without txEnd is quarantined, a complete line failing verification keeps the valid
// prefix and reports a [LogRepair]), migrations and the anchor comparison. It decides
// nothing the engine owns: the [RecoveryReport] says which events to emit
// (epoch_started, ledger_repaired, tamper_detected, guardian_started) and from which seq
// to replay.
//
// Writes other than the log use writeAtomic: a temporary file in the same directory
// (O_EXCL), write, fsync, close, rename over the target (Windows: MoveFileEx
// REPLACE_EXISTING|WRITE_THROUGH, retried on sharing violations), then fsync the
// directory on POSIX. Every file operation goes through [FS], so tests inject failures
// and crashes at every step.
//
// # Concurrency
//
// A Store is safe for concurrent use (one mutex), so API handlers may read events
// while the engine goroutine appends. The engine remains the only writer by contract.
package store
