package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// The testhooks fake clock (docs/ARCHITECTURE.md §15): a build with the testhooks tag
// runs the real binary on an engine.FakeClock that only POST /v1/_test/clock moves. Its
// readings are saved in the data directory after every change and at stop, and a
// restarted guardian resumes them, so an end-to-end test can stop the guardian, start
// it again and find the time where it left it (a restart in the same fake boot that
// took no time). Release builds never read or write this file.

// fakeClockFileName is the saved fake clock inside the data directory.
const fakeClockFileName = "testhooks-clock.json"

// fakeClockDoc is the saved state of an engine.FakeClock.
type fakeClockDoc struct {
	V int `json:"v"`
	// Wall is the wall clock (RFC 3339, nanoseconds).
	Wall string `json:"wall"`
	// BootMs and AwakeMs are the boot and awake clocks.
	BootMs  int64 `json:"bootMs"`
	AwakeMs int64 `json:"awakeMs"`
	// Boots is the boot number (boot id "fake-boot-<Boots>").
	Boots int `json:"boots"`
	// JumpedMs is the sum of the wall-clock jumps (Wall − Real).
	JumpedMs int64 `json:"jumpedMs"`
}

// fakeClock is a FakeClock tied to its file.
type fakeClock struct {
	path  string
	clock *engine.FakeClock
}

// Readings of a new engine.FakeClock and of one right after a Reboot (fakeclock.go of
// the engine: a boot that began an hour earlier; the guardian starts 20 s into a new
// boot).
const (
	fakeFirstBootUptime = time.Hour
	fakeRebootUptime    = 20 * time.Second
	fakeBootPrefix      = "fake-boot-"
	maxFakeClockBytes   = 4096
)

// openFakeClock loads the fake clock saved at path, or starts one at now.
func openFakeClock(path string, now time.Time) (*fakeClock, error) {
	f, err := platform.OpenRegularFile(path, os.O_RDONLY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return &fakeClock{path: path, clock: engine.NewFakeClock(now)}, nil
	}
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFakeClockBytes))
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	var doc fakeClockDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", fakeClockFileName, err)
	}
	c, err := restoreFakeClock(doc)
	if err != nil {
		return nil, err
	}
	return &fakeClock{path: path, clock: c}, nil
}

// save writes the clock's readings atomically.
func (f *fakeClock) save() error {
	raw, err := json.Marshal(snapshotFakeClock(f.clock))
	if err != nil {
		return err
	}
	return store.WriteAtomic(f.path, append(raw, '\n'), platform.FileMode)
}

// snapshotFakeClock reads c's state through its exported readings.
func snapshotFakeClock(c *engine.FakeClock) fakeClockDoc {
	id, _ := c.BootID()
	boots, err := strconv.Atoi(strings.TrimPrefix(id, fakeBootPrefix))
	if err != nil || boots < 1 {
		boots = 1
	}
	wall := c.Wall()
	return fakeClockDoc{
		V:        1,
		Wall:     wall.UTC().Format(time.RFC3339Nano),
		BootMs:   c.Boot().Milliseconds(),
		AwakeMs:  c.Awake().Milliseconds(),
		Boots:    boots,
		JumpedMs: wall.Sub(c.Real()).Milliseconds(),
	}
}

// restoreFakeClock rebuilds a FakeClock with exactly doc's readings by replaying the
// FakeClock operations that lead there: Reboot for every later boot, Advance up to the
// awake clock, Suspend up to the boot clock, then the wall-clock jumps.
func restoreFakeClock(doc fakeClockDoc) (*engine.FakeClock, error) {
	wall, err := time.Parse(time.RFC3339Nano, doc.Wall)
	if doc.V != 1 || err != nil || doc.Boots < 1 {
		return nil, errors.New("unreadable " + fakeClockFileName)
	}
	base := fakeFirstBootUptime
	if doc.Boots > 1 {
		base = fakeRebootUptime
	}
	boot, awake := msDur(doc.BootMs), msDur(doc.AwakeMs)
	jumped := msDur(doc.JumpedMs)
	if awake < base || boot < awake {
		return nil, errors.New("inconsistent " + fakeClockFileName)
	}
	// Every operation below moves the wall clock; start where they end at doc.Wall.
	moves := time.Duration(doc.Boots-1)*fakeRebootUptime + (awake - base) + (boot - awake) + jumped
	c := engine.NewFakeClock(wall.Add(-moves))
	for range doc.Boots - 1 {
		c.Reboot()
	}
	c.Advance(awake - base)
	c.Suspend(boot - awake)
	c.JumpWall(jumped)
	return c, nil
}

func msDur(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }
