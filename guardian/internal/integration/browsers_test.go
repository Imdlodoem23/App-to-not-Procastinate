package integration

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Regression: closeBrowsersWithoutExtension, turned on through PUT /v1/settings, closes
// a browser that runs without a protecting extension during a block and commits
// process_closed{browser_without_extension} with no points (§10.8).
func TestCloseBrowsersWithoutExtensionThroughAPI(t *testing.T) {
	clk := engine.NewFakeClock(testStart)
	sys := newSystem(t, clk)
	sys.start()

	var cur struct {
		Settings map[string]any `json:"settings"`
	}
	sys.call(req{method: "GET", path: "/v1/settings", token: sys.token}, http.StatusOK, &cur)
	cur.Settings["closeBrowsersWithoutExtension"] = true
	var put engine.SettingsResponse
	sys.call(req{method: "PUT", path: "/v1/settings", body: cur.Settings, token: sys.token}, http.StatusOK, &put)
	if !put.Settings.CloseBrowsersWithoutExtension || len(put.Pending) != 0 {
		t.Fatalf("PUT /v1/settings = %+v", put)
	}

	block := sys.createBlock(engine.ModeStrict, 60, "youtube")
	browser := chromeProcess()
	family := catalog.Default().BrowsersForProcess(browser, catalog.CurrentPlatform())[0].ExtensionFamily
	sys.procs.Start(browser)
	editor := sys.procs.Start("some-editor")

	// Fake time past the grace; the close runs on a worker and is recorded by the engine
	// loop, so real time is polled for it.
	sys.advance(4 * time.Minute)
	deadline := time.Now().Add(10 * time.Second)
	var closed []wireEvent
	for {
		sys.advance(2 * time.Second)
		closed = eventsOf(sys.events(), engine.EvProcessClosed)
		if len(closed) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sys.procs.Running(browser) {
		t.Fatal("the browser without the extension is still running")
	}
	procs, _ := sys.procs.List()
	if len(procs) != 1 || procs[0].PID != editor {
		t.Fatalf("processes left: %+v", procs)
	}
	if len(closed) != 1 || closed[0].Points != 0 {
		t.Fatalf("process_closed = %+v", closed)
	}
	var d engine.ProcessClosedData
	if err := json.Unmarshal(closed[0].Data, &d); err != nil {
		t.Fatal(err)
	}
	if d.Reason != "browser_without_extension" || d.Browser == nil || *d.Browser != family ||
		!slices.Equal(d.BlockIDs, []string{block.ID}) {
		t.Fatalf("process_closed data = %+v", d)
	}
}
