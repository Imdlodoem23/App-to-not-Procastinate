package svc

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// HeartbeatInterval is how often the placeholder runner logs.
const HeartbeatInterval = time.Minute

// HeartbeatRunner is a placeholder Runner that only logs a heartbeat every
// interval. The engine replaces it through the NewRunner hook.
type HeartbeatRunner struct {
	logger   *slog.Logger
	interval time.Duration
	// newTicker is replaceable in tests.
	newTicker func(time.Duration) (<-chan time.Time, func())

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

// NewHeartbeatRunner returns a HeartbeatRunner. A nil logger discards output;
// a non-positive interval selects HeartbeatInterval.
func NewHeartbeatRunner(logger *slog.Logger, interval time.Duration) *HeartbeatRunner {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if interval <= 0 {
		interval = HeartbeatInterval
	}
	return &HeartbeatRunner{logger: logger, interval: interval, newTicker: realTicker}
}

func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// Start begins logging heartbeats until ctx is cancelled or Stop is called.
func (r *HeartbeatRunner) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil {
		return errors.New("svc: heartbeat runner already started")
	}
	ctx, cancel := context.WithCancel(ctx)
	tick, stopTick := r.newTicker(r.interval)
	r.cancel, r.done = cancel, make(chan struct{})
	go r.loop(ctx, tick, stopTick, r.done)
	return nil
}

func (r *HeartbeatRunner) loop(ctx context.Context, tick <-chan time.Time, stopTick func(), done chan<- struct{}) {
	defer close(done)
	defer stopTick()
	started := time.Now()
	for n := 1; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-tick:
			r.logger.Info("heartbeat", "n", n, "uptime", time.Since(started).Round(time.Second).String())
		}
	}
}

// Stop ends the heartbeat loop and waits for it. It is safe to call when not started.
func (r *HeartbeatRunner) Stop() error {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.cancel, r.done = nil, nil
	r.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	<-done
	return nil
}
