package engine

import (
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Clock restore at startup (§10.12 step 8). Two sealed copies of the Detector snapshot
// exist: run/clock.json and the one inside state.json. Each carries the log position it
// describes, so the newest wins and a copy older than the log (an older sealed file put
// back, or files deleted) is recognised: the stop it hides is then treated as one of
// unknown length, never as free.

// clockFile is the content of run/clock.json: the snapshot and the log position (epoch,
// seq) it was taken at. Every event with a seq up to Seq was written before it.
// Files written before the position was added decode with an empty Epoch. Clean is set
// by the final save of a clean stop: sealed, unlike run/clean-shutdown, so deleting that
// marker cannot turn a manual stop into a crash (§10.12 step 9).
type clockFile struct {
	clock.Snapshot
	Epoch string `json:"epoch,omitempty"`
	Seq   int64  `json:"seq,omitempty"`
	Clean bool   `json:"clean,omitempty"`
	// Binary identifies the guardian build that wrote it (Options.BinaryID): an update
	// marker exempts a stop only when the binary that starts is another one.
	Binary string `json:"binary,omitempty"`
}

// clockCand is a snapshot found at startup with its log position.
type clockCand struct {
	snap   clock.Snapshot
	epoch  string
	seq    int64
	clean  bool
	binary string
}

// known reports whether the position refers to the current epoch.
func (c *clockCand) known(epoch string) bool { return epoch != "" && c.epoch == epoch }

// newerThan reports whether c describes a later moment than o: the later log position,
// then the later boot-clock reading in one boot, then the later trusted time.
func (c *clockCand) newerThan(o *clockCand, epoch string) bool {
	ck, ok := c.known(epoch), o.known(epoch)
	switch {
	case ck && ok && c.seq != o.seq:
		return c.seq > o.seq
	case ck != ok:
		return ck
	}
	if c.snap.BootID != "" && c.snap.BootID == o.snap.BootID {
		return c.snap.Boot > o.snap.Boot
	}
	return c.snap.Trusted.After(o.snap.Trusted)
}

// olderThan reports whether events were logged after the snapshot was taken, which a
// running guardian never leaves behind (commit saves the snapshot before each append).
func (c *clockCand) olderThan(epoch string, last *store.Event) bool {
	if c.known(epoch) {
		return c.seq < last.Seq
	}
	return c.snap.Trusted.UnixMilli() < atMs(last)
}

// saveClock writes run/clock.json at log position seq of the current epoch; clean
// marks the final save of a clean stop.
func (e *Engine) saveClock(seq int64, clean bool) error {
	return e.st.SaveClock(clockFile{Snapshot: e.det.Snapshot(), Epoch: e.st.Epoch(), Seq: seq, Clean: clean, Binary: e.binaryID()})
}

// clockFileCand reads run/clock.json; a missing, unreadable or tampered file is none.
func (e *Engine) clockFileCand() *clockCand {
	var f clockFile
	ok, err := e.st.LoadClock(&f)
	if err != nil {
		e.log.Warn("clock snapshot unusable", "err", err)
		return nil
	}
	if !ok || f.Trusted.IsZero() {
		return nil
	}
	return &clockCand{snap: f.Snapshot, epoch: f.Epoch, seq: f.Seq, clean: f.Clean, binary: f.Binary}
}

// lastLogged returns the last committed event of the current epoch, or nil.
func (e *Engine) lastLogged() *store.Event {
	epoch, seq := e.st.Epoch(), e.st.LastSeq()
	if epoch == "" || seq <= 0 {
		return nil
	}
	page, err := e.st.ReadEvents(epoch, seq-1, 1)
	if err != nil || len(page.Events) == 0 {
		return nil
	}
	ev := page.Events[len(page.Events)-1]
	return &ev
}

// correctionsAfter sums the calibration corrections (clock_jump{calibrate}) logged
// after seq: a snapshot taken before them still runs ahead by that much.
func (e *Engine) correctionsAfter(seq int64) int64 {
	var sum int64
	epoch := e.st.Epoch()
	for after := seq; ; {
		page, err := e.st.ReadEvents(epoch, after, limits().EventsPageMax)
		if err != nil {
			return sum
		}
		for i := range page.Events {
			ev := &page.Events[i]
			if ev.Type != EvClockJump {
				continue
			}
			if d, err := decode[ClockJumpData](ev); err == nil && d.Source == "calibrate" && d.DeltaMs > 0 {
				sum += d.DeltaMs
			}
		}
		if !page.HasMore || page.LastSeq <= after {
			return sum
		}
		after = page.LastSeq
	}
}

// restoreClock anchors the trusted clock on the newest snapshot and fills what the
// ladder learns about the stop (§10.12 step 8, first half). The stop was clean when the
// clean-shutdown marker exists or the newest snapshot, up to date, says so.
//
//   - same boot: T continues exactly from the snapshot on the boot clock, whatever its
//     age; corrections logged after it are applied again. The stop began at the last
//     trace the previous run left (the snapshot or its last event).
//   - another boot, snapshot up to date: a reboot (the restore of §10.2).
//   - no usable snapshot although events are logged, or one older than the log taken in
//     another boot: the length of the stop cannot be measured and the files that
//     measure it were removed or replaced. T restarts like after a reboot, never below
//     the last trace (the snapshot or the last event), with the restore jump, the boot
//     hold and an immediate calibration; the stop check prices it (unverified).
func (e *Engine) restoreClock(si *startInfo) {
	epoch := e.st.Epoch()
	last := e.lastLogged()
	var lastAt, lastOff int64
	if last != nil {
		lastAt, lastOff = atMs(last), last.WallOffsetMs
	}
	// run/clock.json is written after state.json by every save: it wins a tie.
	cand := si.stateClock
	if f := e.clockFileCand(); f != nil && (cand == nil || !cand.newerThan(f, epoch)) {
		cand = f
	}
	floorT, floorOff := lastAt, lastOff
	si.cleanStop = !si.rep.UncleanShutdown
	if cand != nil {
		rr := e.det.Restore(cand.snap)
		stale := last != nil && cand.olderThan(epoch, last)
		si.cleanStop = si.cleanStop || (cand.clean && !stale)
		if !stale {
			si.prevBinary = cand.binary
		}
		var corr int64
		if stale && cand.known(epoch) {
			corr = e.correctionsAfter(cand.seq)
		}
		snapT := cand.snap.Trusted.UnixMilli() - corr
		switch {
		case rr.Discarded:
			// Corrupt: as if there were none.
		case rr.SameBoot:
			e.startClock()
			if corr > 0 {
				// The correction is logged already; T moves back without a new event.
				e.det.Calibrate(time.UnixMilli(e.now - corr))
				e.startClock()
			}
			si.restored, si.sameBoot = true, true
			si.savedT = snapT
			ran := int64(0)
			if last != nil && lastAt > snapT {
				ran, si.savedT = lastAt-snapT, lastAt
			}
			si.downtime = max(0, rr.Downtime.Milliseconds()-ran)
			if rr.Jump.Jumped() {
				e.pendingStartJump("restore", rr.Jump.Delta.Milliseconds())
			}
			return
		case !stale:
			e.startClock()
			si.restored, si.rebooted = true, true
			si.savedT = snapT
			// Logged on every reboot, not only when the wall clock went back: its
			// reducer rebuilds the restore jump (Clock.Restore) when state.json is lost,
			// and with it the completions a calibration may resurrect (§10.2).
			e.pendingStartJump("reboot", e.wallOffsetMs()-cand.snap.Offset.Milliseconds())
			return
		default:
			// Taken in another boot and older than the log.
			if snapT > floorT {
				floorT, floorOff = snapT, cand.snap.Offset.Milliseconds()+corr
			}
		}
	}
	if last == nil {
		// Nothing logged and no usable snapshot: a first start.
		e.startClock()
		return
	}
	// The stop cannot be measured: resume like after a reboot from the last trace.
	e.det.Restore(clock.Snapshot{
		Wall:    time.UnixMilli(floorT + floorOff).UTC(),
		Trusted: time.UnixMilli(floorT).UTC(),
		Offset:  msDuration(floorOff),
	})
	e.startClock()
	si.restored, si.rebooted, si.unverified = true, true, true
	si.savedT = floorT
	e.pendingStartJump("reboot", e.wallOffsetMs()-floorOff)
	e.log.Warn("clock snapshot missing or older than the event log; the stop is treated as unmeasured")
}
