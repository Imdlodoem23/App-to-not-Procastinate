package hosts

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// manualWatch starts Watch with a ticker driven by the test. tick() returns
// once the poll it triggers has finished (and onChange, if due, has run).
type manualWatch struct {
	ticks   chan time.Time
	changes atomic.Int32
	stop    func() error // cancels Watch and returns its result
}

func startWatch(t *testing.T, m *Manager) *manualWatch {
	t.Helper()
	w := &manualWatch{ticks: make(chan time.Time)}
	done := make(chan error, 1)
	stopped := make(chan struct{})
	m.newTicker = func(d time.Duration) (<-chan time.Time, func()) {
		if d != DefaultPollInterval {
			t.Errorf("poll interval %v, want %v", d, DefaultPollInterval)
		}
		return w.ticks, func() { close(stopped) }
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- m.Watch(ctx, func() { w.changes.Add(1) }) }()
	var once sync.Once
	var result error
	w.stop = func() error {
		once.Do(func() {
			cancel()
			result = <-done
			<-stopped // the ticker was stopped
		})
		return result
	}
	t.Cleanup(func() { _ = w.stop() })
	return w
}

// tick sends two ticks: the second send only completes when the loop is back
// in select, that is, after the first poll and its onChange have finished.
func (w *manualWatch) tick() {
	w.ticks <- time.Now()
	w.ticks <- time.Now()
}

// external runs f the way another process would change the file, but under
// the Manager's lock so it never races with a poll that has the file open
// (Windows refuses to delete an open file).
func external(t *testing.T, m *Manager, f func() error) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := f(); err != nil {
		t.Fatal(err)
	}
}

func TestWatchReportsExternalChangesOnly(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	w := startWatch(t, m)

	w.tick()
	if n := w.changes.Load(); n != 0 {
		t.Fatalf("%d changes reported for an untouched file", n)
	}

	// Someone deletes our lines.
	external(t, m, func() error { return os.WriteFile(path, []byte(linuxHosts), 0o644) })
	w.tick()
	if n := w.changes.Load(); n != 1 {
		t.Fatalf("changes = %d after an external edit, want 1", n)
	}
	w.tick()
	if n := w.changes.Load(); n != 1 {
		t.Fatalf("the same change was reported twice (%d)", n)
	}

	// Our own writes are not reported.
	mustApply(t, m, "a.com")
	mustApply(t, m, "a.com", "b.com")
	mustRemove(t, m)
	mustApply(t, m, "c.com")
	w.tick()
	if n := w.changes.Load(); n != 1 {
		t.Fatalf("our own writes were reported (%d)", n)
	}

	// A change that keeps size and modification time is still caught by the
	// periodic full hash.
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(readString(t, path))
	data[len(data)-3] = 'X' // inside the END marker line
	external(t, m, func() error {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
		return os.Chtimes(path, fi.ModTime(), fi.ModTime())
	})
	for range fullHashEvery {
		w.tick()
	}
	if n := w.changes.Load(); n != 2 {
		t.Fatalf("changes = %d after a same-size, same-mtime edit, want 2", n)
	}

	// The file disappears.
	external(t, m, func() error { return os.Remove(path) })
	w.tick()
	if n := w.changes.Load(); n != 3 {
		t.Fatalf("changes = %d after deletion, want 3", n)
	}

	if err := w.stop(); !errors.Is(err, context.Canceled) {
		t.Fatalf("Watch returned %v, want context.Canceled", err)
	}
}

func TestWatchReportsChangeBeforeStart(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	if err := os.WriteFile(path, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	w := startWatch(t, m)
	w.tick()
	if n := w.changes.Load(); n != 1 {
		t.Fatalf("changes = %d, want 1 (edit made after our write, before Watch)", n)
	}
}

func TestWatchWithoutPriorWriteUsesCurrentContent(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	w := startWatch(t, m)
	w.tick()
	if n := w.changes.Load(); n != 0 {
		t.Fatalf("changes = %d for an untouched file", n)
	}
	external(t, m, func() error { return os.WriteFile(path, []byte(linuxHosts+"# edit\n"), 0o644) })
	w.tick()
	if n := w.changes.Load(); n != 1 {
		t.Fatalf("changes = %d, want 1", n)
	}
}

func TestWatchRealTicker(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	m.PollInterval = 10 * time.Millisecond
	mustApply(t, m, "a.com")
	changed := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- m.Watch(ctx, func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		})
	}()
	time.Sleep(50 * time.Millisecond)
	if err := os.WriteFile(path, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(10 * time.Second):
		t.Fatal("change not reported")
	}
	// The engine re-applies from the callback's goroutine without deadlock.
	mustApply(t, m, "a.com")
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Watch returned %v", err)
	}
}

func TestWatchCallbackMayApply(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	ticks := make(chan time.Time)
	m.newTicker = func(time.Duration) (<-chan time.Time, func()) { return ticks, func() {} }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	var calls atomic.Int32
	go func() {
		done <- m.Watch(ctx, func() {
			calls.Add(1)
			if err := m.Apply([]string{"a.com"}); err != nil {
				t.Error(err)
			}
		})
	}()
	external(t, m, func() error { return os.WriteFile(path, []byte(linuxHosts), 0o644) })
	for range 3 {
		ticks <- time.Now()
	}
	ticks <- time.Now()
	if n := calls.Load(); n != 1 {
		t.Fatalf("onChange calls = %d, want 1 (the re-apply must not trigger another)", n)
	}
	if ok, _ := m.Verify([]string{"a.com"}); !ok {
		t.Fatal("section not restored by the callback")
	}
	cancel()
	<-done
}
