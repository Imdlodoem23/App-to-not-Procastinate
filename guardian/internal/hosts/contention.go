package hosts

import (
	"log/slog"
	"sync"
	"time"
)

// Defaults for Contention.
const (
	DefaultContentionWindow    = time.Minute
	DefaultContentionThreshold = 5
	DefaultContentionMinDelay  = 10 * time.Second
	DefaultContentionMaxDelay  = 5 * time.Minute
)

// Contention dampens the re-apply loop when another program keeps rewriting
// the hosts file: an antivirus remediation (see the package documentation on
// Microsoft Defender), a hosts manager or a script. Without it the watcher
// notices every rewrite, the engine re-applies at once, and the two fight
// every few seconds.
//
// The engine calls Rewritten each time it finds the section altered by
// someone else (Watch reported a change and Verify returned false) and waits
// the returned delay before re-applying. Up to Threshold-1 rewrites within
// Window are re-applied at once. From the Threshold-th on the file is
// contested: the delay starts at MinDelay and doubles with every further
// rewrite up to MaxDelay, and a single warning is logged. The file stops
// being contested once no rewrite has been seen for the current delay plus
// Window.
//
// The zero value uses the defaults. All methods are safe for concurrent use;
// a Contention must not be copied after first use. Time is passed in, so the
// caller's (trusted) clock decides and tests need none.
type Contention struct {
	// Window and Threshold: Threshold external rewrites within Window make
	// the file contested. Zero selects DefaultContentionWindow and
	// DefaultContentionThreshold.
	Window    time.Duration
	Threshold int
	// MinDelay and MaxDelay bound the backoff while contested. Zero selects
	// DefaultContentionMinDelay and DefaultContentionMaxDelay. Set MaxDelay
	// equal to MinDelay for a fixed retry interval.
	MinDelay, MaxDelay time.Duration
	// Logger receives the one warning. Nil discards it.
	Logger *slog.Logger

	mu     sync.Mutex
	recent []time.Time   // rewrites within Window, oldest first
	last   time.Time     // latest rewrite
	delay  time.Duration // current backoff; 0 while not contested
	warned bool          // the warning was logged
}

func (c *Contention) params() (window time.Duration, threshold int, minDelay, maxDelay time.Duration) {
	window, threshold = c.Window, c.Threshold
	minDelay, maxDelay = c.MinDelay, c.MaxDelay
	if window <= 0 {
		window = DefaultContentionWindow
	}
	if threshold <= 0 {
		threshold = DefaultContentionThreshold
	}
	if minDelay <= 0 {
		minDelay = DefaultContentionMinDelay
	}
	if maxDelay <= 0 {
		maxDelay = DefaultContentionMaxDelay
	}
	return window, threshold, minDelay, max(minDelay, maxDelay)
}

// Rewritten records an external rewrite seen at now and returns how long to
// wait before re-applying: 0 while the file is not contested.
func (c *Contention) Rewritten(now time.Time) time.Duration {
	window, threshold, minDelay, maxDelay := c.params()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.settle(now, window)
	cut := now.Add(-window)
	keep := c.recent[:0]
	for _, t := range c.recent {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	c.recent = append(keep, now)
	c.last = now
	switch {
	case c.delay > 0:
		c.delay = min(2*c.delay, maxDelay)
	case len(c.recent) >= threshold:
		c.delay = minDelay
		if !c.warned {
			c.warned = true
			c.logger().Warn("hosts: another program keeps rewriting the hosts file; re-applying with backoff",
				"rewrites", len(c.recent), "window", window, "delay", c.delay)
		}
	}
	return c.delay
}

// Contested reports whether the file is contested at now.
func (c *Contention) Contested(now time.Time) bool {
	window, _, _, _ := c.params()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.settle(now, window)
	return c.delay > 0
}

// Reset forgets every recorded rewrite (the warning is not logged again).
func (c *Contention) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recent, c.last, c.delay = nil, time.Time{}, 0
}

// settle ends contention after a quiet period. Callers hold c.mu.
func (c *Contention) settle(now time.Time, window time.Duration) {
	if c.delay > 0 && now.Sub(c.last) > c.delay+window {
		c.recent, c.delay = nil, 0
	}
}

func (c *Contention) logger() *slog.Logger {
	if c.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return c.Logger
}
