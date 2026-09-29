package engine

import (
	"crypto/rand"
	"sync"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// fmtMs formats Unix milliseconds as a wire timestamp (§4).
func fmtMs(ms int64) string { return store.FormatTime(time.UnixMilli(ms)) }

// fmtTime formats a time as a wire timestamp.
func fmtTime(t time.Time) string { return store.FormatTime(t) }

// parseMs parses a wire timestamp into Unix milliseconds.
func parseMs(s string) (int64, bool) {
	t, err := store.ParseTime(s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// ptr returns a pointer to v.
func ptr[T any](v T) *T { return &v }

// strPtrOrNil is nil for "".
func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// newID generates a guardian id: prefix, "_" and 22 base62 characters from crypto/rand
// (~131 bits, §5.1).
func newID(prefix string) string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	const n = 22
	out := make([]byte, 0, len(prefix)+1+n)
	out = append(out, prefix...)
	out = append(out, '_')
	var buf [64]byte
	for len(out) < len(prefix)+1+n {
		if _, err := rand.Read(buf[:]); err != nil {
			panic("engine: crypto/rand failed: " + err.Error())
		}
		for _, b := range buf {
			// Rejection sampling keeps the distribution uniform (248 = 4 × 62).
			if b >= 248 {
				continue
			}
			out = append(out, alphabet[b%62])
			if len(out) == len(prefix)+1+n {
				break
			}
		}
	}
	return string(out)
}

// embeddedDefaultSettings is DEFAULT_GUARDIAN_SETTINGS (a private copy).
func embeddedDefaultSettings() GuardianSettings { return embedded.API().DefaultSettings.Clone() }

// locationCache avoids reloading zones on every step.
var locationCache sync.Map // name → *time.Location

// loadLocation loads an IANA zone with the embedded tzdata ("Local" is refused).
func loadLocation(name string) (*time.Location, bool) {
	if name == "" || name == "Local" {
		return nil, false
	}
	if l, ok := locationCache.Load(name); ok {
		return l.(*time.Location), true
	}
	l, err := time.LoadLocation(name)
	if err != nil {
		return nil, false
	}
	locationCache.Store(name, l)
	return l, true
}

// location is the zone of local days: settings.timezone, else the OS zone (§4).
func (e *Engine) location() *time.Location {
	if tz := e.state.Settings.Timezone; tz != nil {
		if l, ok := loadLocation(*tz); ok {
			return l
		}
	}
	return time.Local
}

// localDay is the local day (YYYY-MM-DD) of a trusted time.
func (e *Engine) localDay(ms int64) string {
	return time.UnixMilli(ms).In(e.location()).Format(time.DateOnly)
}

// notifier wakes long polls: wait returns a channel closed by the next broadcast.
type notifier struct {
	mu sync.Mutex
	ch chan struct{}
}

func newNotifier() *notifier { return &notifier{ch: make(chan struct{})} }

func (n *notifier) wait() <-chan struct{} {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.ch
}

func (n *notifier) broadcast() {
	n.mu.Lock()
	defer n.mu.Unlock()
	close(n.ch)
	n.ch = make(chan struct{})
}

// ceilDiv is ⌈a / b⌉ for b > 0.
func ceilDiv(a, b int64) int64 {
	if a >= 0 {
		return (a + b - 1) / b
	}
	return -((-a) / b)
}

const msPerMinute = int64(time.Minute / time.Millisecond)

// msDuration converts milliseconds to a time.Duration.
func msDuration(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }
