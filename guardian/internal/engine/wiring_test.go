package engine

import (
	"os"
	"regexp"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

// The Engine is the service Runner (svc.NewRunner wires it with the API layer).
var _ svc.ShutdownRunner = (*Engine)(nil)

// Every error code the engine emits exists in the embedded GUARDIAN_ERROR_STATUS table,
// so APIError.Status never falls back to a literal.
func TestErrorCodesAreEmbedded(t *testing.T) {
	codeRE := regexp.MustCompile(`(?:apiErr|issueErr)\("([a-z_]+)"`)
	files, _ := os.ReadDir(".")
	seen := 0
	for _, f := range files {
		name := f.Name()
		if len(name) < 3 || name[len(name)-3:] != ".go" {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range codeRE.FindAllStringSubmatch(string(src), -1) {
			if m[0][:6] == "issueE" {
				continue // issueErr's first argument is a path
			}
			seen++
			if _, ok := embedded.API().Errors[m[1]]; !ok {
				t.Errorf("%s: code %q is not in GUARDIAN_ERROR_STATUS", name, m[1])
			}
		}
	}
	if seen < 10 {
		t.Fatalf("only %d codes found", seen)
	}
	for _, c := range []string{"read_only", "not_found", "validation_failed", "unknown_field", "protected_target", "duration_out_of_range", "invalid_timezone", "internal"} {
		if (&APIError{Code: c}).Status() < 400 {
			t.Fatalf("status of %s", c)
		}
	}
}
