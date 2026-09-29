package engine

import (
	"fmt"
	"sync"
	"time"
)

// FakeClock is a Clock driven by hand (docs/ARCHITECTURE.md §15). It keeps a wall
// clock, a boot clock (counts during suspend) and an awake clock (stops during suspend)
// and a boot id. It is safe for concurrent use, so the API layer's test hooks
// (POST /v1/_test/clock) and the engine goroutine can share it.
//
//	Advance(d)        real time passes, machine awake: wall, boot and awake move by d
//	Suspend(d)        the machine sleeps for d: wall and boot move, awake does not
//	JumpWall(d)       someone changes the wall clock by d (signed); nothing else moves
//	Reboot()          a new boot: new boot id, boot and awake clocks restart near zero
//	RebootAfter(off)  the machine stays off for off (the wall clock moves), then reboots
//	ServiceRestart(d) the guardian is down for d in the same boot (like Advance); the
//	                  test re-creates the Engine on the same data directory
type FakeClock struct {
	mu       sync.Mutex
	wall     time.Time
	boot     time.Duration
	awake    time.Duration
	bootID   string
	boots    int
	restarts int
	// jumped is the sum of JumpWall moves: Real is Wall minus it.
	jumped time.Duration
}

// fakeBootUptime is how long after boot the guardian starts in a fake new boot.
const fakeBootUptime = 20 * time.Second

// NewFakeClock returns a FakeClock whose wall clock reads start (UTC), in a boot that
// began an hour earlier.
func NewFakeClock(start time.Time) *FakeClock {
	return &FakeClock{wall: start.UTC(), boot: time.Hour, awake: time.Hour, bootID: "fake-boot-1", boots: 1}
}

// Wall implements Clock.
func (c *FakeClock) Wall() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wall
}

// Boot implements Clock.
func (c *FakeClock) Boot() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.boot
}

// Awake implements Clock.
func (c *FakeClock) Awake() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.awake
}

// BootID implements Clock.
func (c *FakeClock) BootID() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bootID, nil
}

// BootClockName and AwakeClockName name the fake clocks in diagnostics.
func (c *FakeClock) BootClockName() string  { return "fake-boot" }
func (c *FakeClock) AwakeClockName() string { return "fake-awake" }

// Advance moves real time with the machine awake. Negative values are ignored.
func (c *FakeClock) Advance(d time.Duration) {
	if d <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
	c.boot += d
	c.awake += d
}

// Suspend moves real time with the machine asleep: the awake clock stops.
func (c *FakeClock) Suspend(d time.Duration) {
	if d <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
	c.boot += d
}

// JumpWall changes the wall clock by d (positive: forward) without real time passing.
func (c *FakeClock) JumpWall(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
	c.jumped += d
}

// Real is the true current time: the wall clock without the JumpWall moves (what a
// network time check answers, see FakeNetworkTime).
func (c *FakeClock) Real() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wall.Add(-c.jumped)
}

// Reboot starts a new boot at once: a new boot id, and boot and awake clocks restart.
func (c *FakeClock) Reboot() { c.RebootAfter(0) }

// RebootAfter models a machine that stays off for off (real time: the wall clock moves)
// and then boots; the guardian starts fakeBootUptime into the new boot.
func (c *FakeClock) RebootAfter(off time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if off > 0 {
		c.wall = c.wall.Add(off)
	}
	c.wall = c.wall.Add(fakeBootUptime)
	c.boots++
	c.bootID = fmt.Sprintf("fake-boot-%d", c.boots)
	c.boot = fakeBootUptime
	c.awake = fakeBootUptime
}

// ServiceRestart models the guardian being down for down in the same boot (the machine
// stays awake). The caller stops the Engine before and opens a new one after.
func (c *FakeClock) ServiceRestart(down time.Duration) {
	c.mu.Lock()
	c.restarts++
	c.mu.Unlock()
	c.Advance(down)
}

// Restarts counts ServiceRestart calls.
func (c *FakeClock) Restarts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.restarts
}
