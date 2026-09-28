package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func validBlockJSON(t *testing.T, edit func(m map[string]any)) string {
	t.Helper()
	m := blockBody(60)
	if edit != nil {
		edit(m)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestDecodeBodyIssues(t *testing.T) {
	cases := []struct {
		name, body, code, path, issue string
	}{
		{"unknown top-level field", validBlockJSON(t, func(m map[string]any) { m["shorten"] = true }), codeUnknownField, "shorten", "unknown_field"},
		{"unknown nested field", validBlockJSON(t, func(m map[string]any) { m["targets"].(map[string]any)["wildcards"] = []string{"*"} }), codeUnknownField, "targets.wildcards", "unknown_field"},
		{"missing field", validBlockJSON(t, func(m map[string]any) { delete(m, "reason") }), codeValidationFailed, "reason", "required"},
		{"missing nullable field", validBlockJSON(t, func(m map[string]any) { delete(m, "endsAt") }), codeValidationFailed, "endsAt", "required"},
		{"missing nested list", validBlockJSON(t, func(m map[string]any) { delete(m["allow"].(map[string]any), "customProcesses") }), codeValidationFailed, "allow.customProcesses", "required"},
		{"fractional integer", validBlockJSON(t, func(m map[string]any) { m["durationMinutes"] = 60.5 }), codeValidationFailed, "durationMinutes", "type"},
		{"string for integer", validBlockJSON(t, func(m map[string]any) { m["durationMinutes"] = "60" }), codeValidationFailed, "durationMinutes", "type"},
		{"huge integer", strings.Replace(validBlockJSON(t, nil), `"durationMinutes":60`, `"durationMinutes":1e30`, 1), "duration_out_of_range", "durationMinutes", "range"},
		{"null list", validBlockJSON(t, func(m map[string]any) { m["targets"].(map[string]any)["serviceIds"] = nil }), codeValidationFailed, "targets.serviceIds", "type"},
		{"number in string list", validBlockJSON(t, func(m map[string]any) { m["targets"].(map[string]any)["serviceIds"] = []any{"youtube", 3} }), codeValidationFailed, "targets.serviceIds[1]", "type"},
		{"null bool", validBlockJSON(t, func(m map[string]any) { m["whitelistOnly"] = nil }), codeValidationFailed, "whitelistOnly", "type"},
		{"null root", "null", codeValidationFailed, "$", "type"},
		{"array root", "[]", codeValidationFailed, "$", "type"},
		// Key order of the TS validators: known keys first, unknown ones after.
		{"missing before unknown", `{"zzz":1}`, codeValidationFailed, "targets", "required"},
	}
	for _, c := range cases {
		_, err := decodeBody[engine.CreateBlockRequest]([]byte(c.body))
		if err == nil {
			t.Errorf("%s: accepted", c.name)
			continue
		}
		if err.Code != c.code || err.Details["path"] != c.path || err.Details["issue"] != c.issue {
			t.Errorf("%s: got %s %v, want %s {%s %s}", c.name, err.Code, err.Details, c.code, c.path, c.issue)
		}
	}
}

func TestDecodeBodySyntax(t *testing.T) {
	for _, body := range []string{
		``, `{`, `{"a":1,}`, `{"a":1}{"b":2}`, `{"a":1} x`, `{'a':1}`, `{"a":01}`, `{"a":NaN}`,
		`{"reason":"a","reason":"b"}`, `{"targets":{"serviceIds":[],"serviceIds":[]}}`,
		`{"a":"\x01"}`, "{\"a\":\"\xff\"}", `{"a":"\u00"}`, "\xef\xbb\xbf{}",
		strings.Repeat("[", 40) + strings.Repeat("]", 40),
	} {
		_, err := decodeBody[engine.CreateBlockRequest]([]byte(body))
		if err == nil || err.Code != codeInvalidJSON {
			t.Errorf("%q: got %v, want invalid_json", body, err)
		}
	}
	// Escaped duplicate keys are duplicates.
	if _, err := decodeBody[struct{}]([]byte(`{"a":1,"a":2}`)); err == nil || err.Code != codeInvalidJSON {
		t.Errorf("escaped duplicate: %v", err)
	}
}

func TestDecodeBodyValues(t *testing.T) {
	body := validBlockJSON(t, nil)
	body = strings.Replace(body, `"durationMinutes":60`, `"durationMinutes":6.0e1`, 1)
	req, err := decodeBody[engine.CreateBlockRequest]([]byte(body))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.DurationMinutes == nil || *req.DurationMinutes != 60 || req.EndsAt != nil || req.Reason != "Quiero aprobar mates" ||
		len(req.Targets.ServiceIDs) != 1 || req.Targets.CategoryIDs == nil || req.Mode != "strict" {
		t.Fatalf("decoded %+v", req)
	}
	// EmptyRequest: {} only.
	if _, err := decodeBody[struct{}]([]byte(`{}`)); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if _, err := decodeBody[struct{}]([]byte(`{"x":1}`)); err == nil || err.Code != codeUnknownField || err.Details["path"] != "x" {
		t.Fatalf("empty with field: %v", err)
	}
	// Nullable nested object (pomodoro) and settings with a null timezone.
	study := `{"task":"mates","plannedMinutes":60,"pomodoro":null,"camera":false}`
	if _, err := decodeBody[engine.StartStudyRequest]([]byte(study)); err != nil {
		t.Fatalf("study: %v", err)
	}
	study = `{"task":"mates","plannedMinutes":60,"pomodoro":{"workMinutes":25},"camera":false}`
	if _, err := decodeBody[engine.StartStudyRequest]([]byte(study)); err == nil || err.Details["path"] != "pomodoro.breakMinutes" {
		t.Fatalf("pomodoro: %v", err)
	}
	settings := `{"timezone":5,"dailyGoalMinutes":60,"attemptPenalties":true,"punishment":{"level":"distractions","minutes":60},` +
		`"closeBrowsersWithoutExtension":false,"serverTimeCheck":true,"studyWhitelist":{"extraDomains":[],"extraProcesses":[]}}`
	if _, err := decodeBody[engine.GuardianSettings]([]byte(settings)); err == nil || err.Details["path"] != "timezone" || err.Details["issue"] != "type" {
		t.Fatalf("settings: %v", err)
	}
	// Integers are refused past their Go size.
	type small struct {
		N int32 `json:"n"`
	}
	if _, err := decodeBody[small]([]byte(`{"n":3000000000}`)); err == nil || err.Details["issue"] != "range" {
		t.Fatalf("int32 overflow: %v", err)
	}
}

// TestUnknownFieldsRejectedOverHTTP: the strict decoding runs for every body route.
func TestUnknownFieldsRejectedOverHTTP(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("POST", "/v1/blocks", validBlockJSON(t, func(m map[string]any) { m["shorten"] = true }), env.app())
	expect(t, r, http.StatusBadRequest, codeUnknownField)
	if d := r.errDetails(); d["path"] != "shorten" || d["issue"] != "unknown_field" {
		t.Fatalf("details = %v", d)
	}
	id := env.createBlock(30)
	r = env.do("POST", "/v1/blocks/"+id+"/extend", `{"addMinutes":10,"setMinutes":0}`, env.app())
	expect(t, r, http.StatusBadRequest, codeUnknownField)
	expect(t, env.do("POST", "/v1/blocks/"+id+"/extend", `{"addMinutes":10.0}`, env.app()), http.StatusOK, "")
	expect(t, env.do("POST", "/v1/pairing/code", `{"force":true}`, env.app()), http.StatusBadRequest, codeUnknownField)
	expect(t, env.do("POST", "/v1/blocks", `{"reason":"a","reason":"b"}`, env.app()), http.StatusBadRequest, codeInvalidJSON)
	r = env.do("POST", "/v1/blocks", validBlockJSON(t, func(m map[string]any) { delete(m, "mode") }), env.app())
	expect(t, r, http.StatusUnprocessableEntity, codeValidationFailed)
	// Semantic validation is the engine's (after the shape).
	r = env.do("POST", "/v1/blocks", validBlockJSON(t, func(m map[string]any) { m["durationMinutes"] = 4 }), env.app())
	expect(t, r, http.StatusUnprocessableEntity, "duration_out_of_range")
}
