package api

import (
	"sync"
	"time"
)

// Rate limits of docs/ARCHITECTURE.md §9.6 that the generated data does not carry
// (the pairing claim window does, and is read from there).
const (
	// appRate/appBurst: the app token's token bucket (requests per second).
	appRate  = 50
	appBurst = 100
	// extRate/extBurst: each extension token's bucket.
	extRate  = 10
	extBurst = 20
	// attemptRate/attemptBurst: POST /v1/attempts per extension token.
	attemptRate  = 5
	attemptBurst = 5
	// maxLongPollsPerToken: concurrent long polls per token (§8.5).
	maxLongPollsPerToken = 4
	// maxBuckets bounds the bucket table (one per paired extension plus the app);
	// idle full buckets are dropped beyond it.
	maxBuckets = 256
)

// bucket is one token bucket.
type bucket struct {
	tokens      float64
	last        time.Time
	rate, burst float64
}

// rateLimiter holds token buckets by key ("app", "ext:<id>", "att:<id>").
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

func newRateLimiter() *rateLimiter { return &rateLimiter{buckets: map[string]*bucket{}} }

// take spends one token of the key's bucket (rate tokens per second, at most burst).
// When the bucket is empty it returns false and how long until a token is back.
func (l *rateLimiter) take(key string, now time.Time, rate, burst float64) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= maxBuckets {
			l.prune(now)
		}
		b = &bucket{tokens: burst, last: now, rate: rate, burst: burst}
		l.buckets[key] = b
	}
	if el := now.Sub(b.last); el > 0 {
		b.tokens = min(burst, b.tokens+el.Seconds()*rate)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / rate * float64(time.Second))
	return false, max(wait, time.Millisecond)
}

// prune drops the buckets that refilled completely (they carry no state), and the
// least recently used one when all are busy. Keys only come from authenticated tokens
// (the app and paired extensions), so this is a bound, not a defence.
func (l *rateLimiter) prune(now time.Time) {
	oldest := ""
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*b.rate >= b.burst {
			delete(l.buckets, k)
			continue
		}
		if oldest == "" || b.last.Before(l.buckets[oldest].last) {
			oldest = k
		}
	}
	if len(l.buckets) >= maxBuckets && oldest != "" {
		delete(l.buckets, oldest)
	}
}

// windowLimiter allows at most n events per sliding window (the global pairing claim
// limit, §9.3).
type windowLimiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	at     []time.Time
}

// allow records an event at now, or returns false and when the oldest one leaves the
// window.
func (w *windowLimiter) allow(now time.Time) (bool, time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	keep := w.at[:0]
	for _, t := range w.at {
		if now.Sub(t) < w.window {
			keep = append(keep, t)
		}
	}
	w.at = keep
	if len(w.at) >= w.n {
		return false, max(w.at[0].Add(w.window).Sub(now), time.Millisecond)
	}
	w.at = append(w.at, now)
	return true, 0
}

// pollLimiter counts the long polls in flight per token key.
type pollLimiter struct {
	mu     sync.Mutex
	active map[string]int
}

func newPollLimiter() *pollLimiter { return &pollLimiter{active: map[string]int{}} }

// acquire reserves a long poll for key; release must be called when it ends.
func (p *pollLimiter) acquire(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active[key] >= maxLongPollsPerToken {
		return false
	}
	p.active[key]++
	return true
}

func (p *pollLimiter) release(key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active[key] <= 1 {
		delete(p.active, key)
		return
	}
	p.active[key]--
}

// inFlight is the number of long polls of key (tests).
func (p *pollLimiter) inFlight(key string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active[key]
}
