package engine

import (
	"context"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// Process watcher detections (§10.8). The watcher (its own goroutine) closes matching
// processes and reports each launch; the engine decides what it costs: the grace cases
// (a process already running when the block started, a process started right after the
// user's logon) emit process_closed without points, the rest go to the attempt pipeline
// of attempts.go.

// processDetection is one launch the watcher closed, with the blocks that cover it.
type processDetection struct {
	// Target is the matcher target that matched; Name the executable name.
	Target string
	Name   string
	PIDs   []int
	// ServiceID and AppID are the catalog service and app of the executable ("" none).
	ServiceID string
	AppID     string
	// Blocks are the active blocks that cover the target (creation order).
	Blocks []*blockRec
}

// ReportProcessKilled hands a watcher report to the engine (the watcher goroutine calls
// it through Start; tests call it directly).
func (e *Engine) ReportProcessKilled(ctx context.Context, k procwatch.Killed) error {
	return e.exec(ctx, func() {
		if !e.opened {
			return
		}
		e.timeStep()
		e.onProcessKilled(k)
		e.afterTurn()
	})
}

// onProcessKilled turns a closed launch into process_closed or an attempt.
func (e *Engine) onProcessKilled(k procwatch.Killed) {
	e.kills = append(e.kills, e.now)
	if e.isFrozen() {
		return
	}
	d := processDetection{Target: k.Target, Name: k.Name, PIDs: slices.Clone(k.PIDs)}
	name := k.Name
	if name == "" {
		name = k.Target
	}
	if s := e.cat.FindServiceByProcessName(name, e.platform); s != nil {
		d.ServiceID = s.ID
	}
	if a := e.cat.FindAppByProcessName(name, e.platform); a != nil {
		d.AppID = a.ID
	}
	d.Blocks = e.blocksCoveringProcess(k.Target)
	if len(d.Blocks) == 0 {
		return
	}
	if reason := e.processGrace(d.Blocks); reason != "" {
		b := e.newBatch()
		ids := make([]string, len(d.Blocks))
		for i, blk := range d.Blocks {
			ids[i] = blk.ID
		}
		b.add(EvProcessClosed, ProcessClosedData{
			Reason:    reason,
			ServiceID: strPtrOrNil(d.ServiceID),
			AppID:     strPtrOrNil(d.AppID),
			Browser:   nil,
			BlockIDs:  ids,
		})
		e.commitNow(b, "process_closed")
		return
	}
	e.processAttempt(d)
}

// processGrace is the process_closed reason when the detection earns no attempt (§10.8):
// every covering block started less than 60 s ago (the process was running when it
// started), or the user logged on less than 90 s ago.
func (e *Engine) processGrace(blocks []*blockRec) string {
	young := true
	for _, b := range blocks {
		if e.now-b.StartsAt >= processStartGrace.Milliseconds() {
			young = false
			break
		}
	}
	if young {
		return "running_at_block_start"
	}
	if e.o.LogonBoot != nil {
		if at, ok := e.o.LogonBoot(); ok && e.bootNow-at >= 0 && e.bootNow-at < processLogonGrace {
			return "logon_grace"
		}
	}
	return ""
}

// blocksCoveringProcess returns the active blocks whose enforcement includes the
// process target: its resolved processes, or the whitelist rule's app part.
func (e *Engine) blocksCoveringProcess(target string) []*blockRec {
	var out []*blockRec
	allApps := e.allAppProcesses()
	for _, b := range e.activeBlocks() {
		if b.WhitelistOnly {
			if b.WL != nil && containsProcess(allApps, target, e.platform) && !containsProcess(b.WL.Processes, target, e.platform) {
				out = append(out, b)
			}
			continue
		}
		if containsProcess(b.Resolved.Processes, target, e.platform) {
			out = append(out, b)
		}
	}
	return out
}

// processKey is the dedupe key of a process detection (§10.8).
func (e *Engine) processKey(name string) string {
	return e.cat.ProcessTargetKey(name, e.platform)
}
