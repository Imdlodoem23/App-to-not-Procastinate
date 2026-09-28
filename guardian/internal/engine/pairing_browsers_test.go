package engine

import (
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// testBrowser returns a browser executable of this platform and its extension family.
func testBrowser(t *testing.T, e *Engine) (proc, family string) {
	t.Helper()
	for _, b := range e.cat.Browsers() {
		if names := b.Processes.For(string(e.platform)); len(names) > 0 && b.ExtensionFamily != "other" {
			return names[0], e.cat.BrowsersForProcess(names[0], e.platform)[0].ExtensionFamily
		}
	}
	t.Skip("no browser executable on this platform")
	return "", ""
}

// settleBrowserClose waits for a browser close running on its worker to be recorded.
func settleBrowserClose(t *testing.T, env *testEnv) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		closing := false
		if err := env.e.exec(bg, func() { closing = env.e.pairingMem().closing }); err != nil {
			t.Fatal(err)
		}
		if !closing {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("browser close still running")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stepBrowsers advances d and runs one step, then waits for any browser close.
func stepBrowsers(t *testing.T, env *testEnv, d time.Duration) {
	t.Helper()
	env.clk.Advance(d)
	env.e.Step()
	settleBrowserClose(t, env)
}

func enableCloseBrowsers(t *testing.T, env *testEnv) {
	t.Helper()
	s := setGet(t, env).Settings
	s.CloseBrowsersWithoutExtension = true
	if res := setPut(t, env, s); !res.Settings.CloseBrowsersWithoutExtension || len(res.Pending) != 0 {
		t.Fatalf("closeBrowsersWithoutExtension not applied at once: %+v", res)
	}
}

// Regression: closeBrowsersWithoutExtension had no effect. With the option on and a
// block active, a browser without a protecting extension is closed after the grace and
// process_closed{browser_without_extension} is committed without points (§10.8).
func TestCloseBrowsersWithoutExtension(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	proc, family := testBrowser(t, e)
	enableCloseBrowsers(t, env)
	blk := env.create(durationReq(ModeStrict, 60, "youtube"))
	editor := env.procs.Start("some-editor")
	env.procs.Start(proc)
	env.procs.Start(proc)
	// A system process with a browser name (another session's) is never touched.
	env.procs.mu.Lock()
	env.procs.procs = append(env.procs.procs, procwatch.Process{PID: 77, Name: proc, System: true})
	env.procs.mu.Unlock()
	grace := time.Duration(limits().BrowserWithoutExtensionGraceMs) * time.Millisecond

	stepBrowsers(t, env, 0)
	stepBrowsers(t, env, grace/2)
	if !env.procs.Running(proc) || len(env.eventsOf(EvProcessClosed)) != 0 {
		t.Fatal("browser closed within the grace")
	}
	stepBrowsers(t, env, grace/2)
	procs, _ := env.procs.List()
	for _, p := range procs {
		if p.Name == proc && !p.System {
			t.Fatalf("browser still running: %+v", procs)
		}
	}
	if !slices.ContainsFunc(procs, func(p procwatch.Process) bool { return p.PID == 77 }) ||
		!slices.ContainsFunc(procs, func(p procwatch.Process) bool { return p.PID == editor }) {
		t.Fatalf("closed something else: %+v", procs)
	}
	evs := env.eventsOf(EvProcessClosed)
	if len(evs) != 1 || evs[0].Points != 0 {
		t.Fatalf("process_closed %+v", evs)
	}
	d := mustDecode[ProcessClosedData](t, evs[0])
	if d.Reason != "browser_without_extension" || d.Browser == nil || *d.Browser != family ||
		!slices.Equal(d.BlockIDs, []string{blk.ID}) || d.ServiceID != nil || d.AppID != nil {
		t.Fatalf("process_closed data %+v", d)
	}
	if len(env.eventsOf(EvAttempt)) != 0 {
		t.Fatal("a browser close counted an attempt")
	}

	// A relaunched browser gets the grace again, then is closed again.
	env.procs.Start(proc)
	stepBrowsers(t, env, browserScanEvery)
	if !env.procs.Running(proc) {
		t.Fatal("relaunched browser closed without a grace")
	}
	stepBrowsers(t, env, grace)
	stepBrowsers(t, env, browserScanEvery)
	if got := len(env.eventsOf(EvProcessClosed)); got != 2 {
		t.Fatalf("process_closed after the relaunch: %d", got)
	}
}

// The option off, or no active block: browsers without the extension stay open.
func TestCloseBrowsersWithoutExtensionNeedsOptionAndBlock(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	proc, _ := testBrowser(t, e)
	env.procs.Start(proc)
	grace := time.Duration(limits().BrowserWithoutExtensionGraceMs) * time.Millisecond

	env.create(durationReq(ModeStrict, 5, "youtube"))
	stepBrowsers(t, env, 0)
	stepBrowsers(t, env, grace+browserScanEvery)
	if !env.procs.Running(proc) {
		t.Fatal("closed with the option off")
	}
	env.advance(6 * time.Minute) // the block ends
	enableCloseBrowsers(t, env)
	stepBrowsers(t, env, browserScanEvery)
	if !env.procs.Running(proc) || len(env.eventsOf(EvProcessClosed)) != 0 {
		t.Fatal("closed with no active block")
	}
}

// A browser whose extension heartbeat arrives is spared, and so is one whose extension
// connected right before the close (the listing is fresh and the protection is read
// again on the engine goroutine).
func TestCloseBrowsersSparesProtected(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	proc, family := testBrowser(t, e)
	enableCloseBrowsers(t, env)
	env.create(durationReq(ModeStrict, 60, "youtube"))
	env.procs.Start(proc)
	grace := time.Duration(limits().BrowserWithoutExtensionGraceMs) * time.Millisecond
	stepBrowsers(t, env, 0)
	env.clk.Advance(grace)
	// The extension connects after the grace but before the step that would close it.
	x := pairExt(t, env, family)
	if _, err := pairHeartbeat(env, x.ExtensionID, family, e.state.Versions.ExtRules); err != nil {
		t.Fatal(err)
	}
	stepBrowsers(t, env, 0)
	stepBrowsers(t, env, browserScanEvery)
	if !env.procs.Running(proc) || len(env.eventsOf(EvProcessClosed)) != 0 {
		t.Fatal("closed a browser with a protecting extension")
	}
}

// A kill that fails (the process exited on its own) commits nothing.
func TestCloseBrowsersKillFails(t *testing.T) {
	kills := []browserKill{{family: "chrome", procs: []procwatch.Process{{PID: 10, Name: "chrome"}}}}
	failing := procwatch.KillerFunc(func(int, string) error { return procwatch.ErrNotFound })
	if got := killBrowsers(failing, kills); len(got) != 0 {
		t.Fatalf("closed %v", got)
	}
	panicking := procwatch.KillerFunc(func(int, string) error { panic("boom") })
	if got := killBrowsers(panicking, kills); len(got) != 0 {
		t.Fatalf("closed %v", got)
	}
	ok := procwatch.KillerFunc(func(int, string) error { return nil })
	if got := killBrowsers(ok, kills); !slices.Equal(got, []string{"chrome"}) {
		t.Fatalf("closed %v", got)
	}
}
