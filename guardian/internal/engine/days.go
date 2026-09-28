package engine

import (
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Local days and the streak (§6.3): day_closed is emitted for each local day that ends
// while the guardian runs and, at startup, for the last open day if it already ended.
// Days the machine was off are never emitted: the ledger's consecutive-day check breaks
// the streak for them.

// closeDays closes the open day when the local day of T moved past it. The batch is
// stamped with the day that ends, so the study focus flushed first (study.go) still
// counts for it; its goal is the one in force.
func (e *Engine) closeDays(T int64) {
	today := e.localDay(T)
	open := e.state.OpenDay
	if open == "" {
		e.state.OpenDay = today
		return
	}
	if open >= today {
		return
	}
	if lc := e.state.Ledger.LastClosedDay; lc != nil && *lc >= open {
		e.state.OpenDay = today
		return
	}
	b := e.newBatch()
	b.day = open
	e.studyFlushForDayClose(b)
	b.add(EvDayClosed, DayClosedData{Day: open, GoalMinutes: e.goalMinutes()})
	if e.commitNow(b, "day_closed") {
		e.state.OpenDay = today
	}
}

// goalMinutes is the daily goal in force.
func (e *Engine) goalMinutes() int64 { return int64(e.state.Settings.DailyGoalMinutes) }

// pointsSummary is the Progress summary (§5.9) with the running session's pending
// focus minutes.
func (e *Engine) pointsSummary() PointsSummary {
	return points.SummarizeLedger(e.state.Ledger, points.SummaryOptions{
		Today:               e.localDay(e.now),
		GoalMinutes:         e.goalMinutes(),
		PendingFocusMinutes: e.studyPendingFocusMinutes(),
	}, points.DefaultPointRules())
}
